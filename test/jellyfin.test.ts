import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pollConnector } from "../src/connectors/fanin.js";
import {
  jellyfinConnector,
  userDataToInbound,
} from "../src/connectors/jellyfin.js";
import { saveMatch } from "../src/connectors/store.js";
import type { HttpTransport } from "../src/connectors/types.js";
import { resetEncryptionKeyCache } from "../src/crypto/secrets.js";
import { DOC, makeTestApp, registerUser } from "./helpers.js";

function fakeTransport() {
  const calls: {
    url: string;
    method: string;
    body?: string;
    headers?: Record<string, string>;
  }[] = [];
  const handlers: { match: string; status: number; body: unknown }[] = [];
  const t: HttpTransport = async (url, init) => {
    const headers = init.headers as Record<string, string> | undefined;
    calls.push({ url, method: init.method ?? "GET", body: init.body, headers });
    const h = [...handlers]
      .reverse()
      .find(
        (x) => url.includes(x.match) || (init.body ?? "").includes(x.match),
      );
    const status = h?.status ?? 200;
    const body = h?.body ?? {};
    return {
      status,
      text: async () =>
        typeof body === "string" ? body : JSON.stringify(body),
      json: async () => body,
    };
  };
  return {
    transport: t,
    calls,
    on: (m: string, s: number, b: unknown) =>
      handlers.push({ match: m, status: s, body: b }),
  };
}

const CRED = { server: "jf.test", username: "reader", password: "secret" };
const AUTH = { AccessToken: "access-tok", User: { Id: "user-1" } };
const INFO_12 = { Version: "12.0.3" };
const INFO_11 = { Version: "11.0.0" };

function wireAuth(fake: ReturnType<typeof fakeTransport>) {
  fake.on("AuthenticateByName", 200, AUTH);
  fake.on("/System/Info", 200, INFO_12);
}

const KEY = { TOKEN_ENC_KEY: "a".repeat(64) };
beforeEach(() => {
  Object.assign(process.env, KEY);
  resetEncryptionKeyCache();
});
afterEach(() => {
  delete process.env.TOKEN_ENC_KEY;
  resetEncryptionKeyCache();
});

describe("jellyfin userDataToInbound", () => {
  it("uses PlayedPercentage and LastPlayedDate", () => {
    const ch = userDataToInbound(
      "book-1",
      {
        PlayedPercentage: 42,
        LastPlayedDate: "2026-01-15T12:00:00.000Z",
      },
      1_000_000,
    );
    expect(ch).toEqual({
      externalId: "book-1",
      percentage: 0.42,
      finished: false,
      updatedAtMs: Date.parse("2026-01-15T12:00:00.000Z"),
    });
  });

  it("falls back to ticks over RunTimeTicks", () => {
    const ch = userDataToInbound(
      "book-1",
      {
        PlaybackPositionTicks: 250_000,
        LastPlayedDate: "2026-01-15T12:00:00.000Z",
      },
      1_000_000,
    );
    expect(ch?.percentage).toBe(0.25);
  });

  it("returns null without LastPlayedDate", () => {
    expect(userDataToInbound("x", { PlayedPercentage: 10 }, 100)).toBeNull();
  });
});

describe("jellyfin connector", () => {
  it("validate accepts 12.x and rejects 11.x", async () => {
    const fake = fakeTransport();
    wireAuth(fake);
    fake.on("/System/Info", 200, INFO_11);
    const bad = await jellyfinConnector.validate(CRED, fake.transport);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/12\.0/);

    fake.on("/System/Info", 200, INFO_12);
    let ok = await jellyfinConnector.validate(CRED, fake.transport);
    expect(ok.ok).toBe(true);
    expect(ok.accountLabel).toContain("reader");

    fake.on("/System/Info", 200, { Version: "12.10.1" });
    ok = await jellyfinConnector.validate(
      { ...CRED, server: "jf2.test" },
      fake.transport,
    );
    expect(ok.ok).toBe(true);
  });

  it("login uses X-Emby-Authorization and API calls use MediaBrowser Token", async () => {
    const fake = fakeTransport();
    wireAuth(fake);
    fake.on("/Users/user-1/Items", 200, { Items: [] });
    const cred = {
      server: "jf-auth.test",
      username: "auth-user",
      password: "secret",
    };
    await jellyfinConnector.match(
      cred,
      { document: "d", title: "Dune", author: "Frank Herbert", filename: null },
      fake.transport,
    );
    const authCall = fake.calls.find((c) =>
      c.url.includes("AuthenticateByName"),
    );
    const hdrs = authCall?.headers as Record<string, string> | undefined;
    const authzClient = hdrs?.authorization ?? hdrs?.Authorization;
    expect(authzClient).toMatch(/MediaBrowser Client/);
    const apiCall = fake.calls.find(
      (c) => c.url.includes("/Users/user-1/Items") && c.method === "GET",
    );
    const authz = (apiCall?.headers as Record<string, string> | undefined)
      ?.authorization;
    expect(authz).toMatch(/MediaBrowser Token="access-tok"/);
  });

  it("match picks the book by author", async () => {
    const fake = fakeTransport();
    wireAuth(fake);
    fake.on("/Users/user-1/Items", 200, {
      Items: [
        {
          Id: "a",
          Name: "Dune",
          People: [{ Name: "Someone Else", Role: "Writer" }],
        },
        {
          Id: "b",
          Name: "Dune",
          People: [{ Name: "Frank Herbert", Role: "Writer" }],
          RunTimeTicks: 500_000,
        },
      ],
    });
    const m = await jellyfinConnector.match(
      CRED,
      { document: DOC, title: "Dune", author: "Frank Herbert", filename: null },
      fake.transport,
    );
    expect(m?.externalId).toBe("b");
    expect(m?.externalEdition).toBe("500000");
  });

  it("push posts UserData and skips when Jellyfin is newer", async () => {
    const fake = fakeTransport();
    wireAuth(fake);
    fake.on("/UserData", 200, {
      LastPlayedDate: "2030-01-01T00:00:00.000Z",
      PlayedPercentage: 90,
    });
    const skip = await jellyfinConnector.push(
      CRED,
      { externalId: "book-1", confidence: 1, externalEdition: "1000000" },
      {
        kind: "progress",
        document: DOC,
        percentage: 0.5,
        progress: "p",
        position: null,
        timestamp: 1_700_000_000,
      },
      fake.transport,
    );
    expect(skip.ok).toBe(true);
    expect(
      fake.calls.filter(
        (c) => c.method === "POST" && c.url.includes("UserData"),
      ),
    ).toHaveLength(0);

    fake.on("/UserData", 200, { LastPlayedDate: "2020-01-01T00:00:00.000Z" });
    const r = await jellyfinConnector.push(
      CRED,
      { externalId: "book-1", confidence: 1, externalEdition: "1000000" },
      {
        kind: "progress",
        document: DOC,
        percentage: 0.5,
        progress: "p",
        position: null,
        timestamp: 1_700_000_000,
      },
      fake.transport,
    );
    expect(r.ok).toBe(true);
    const post = fake.calls.find(
      (c) => c.method === "POST" && c.url.includes("/Items/book-1/UserData"),
    );
    expect(post).toBeTruthy();
    const body = JSON.parse(post!.body!);
    expect(body).toMatchObject({
      PlayedPercentage: 50,
      PlaybackPositionTicks: 500_000,
      Played: false,
    });
  });

  it("treats 403 on UserData as per-item failure, not reauth", async () => {
    const fake = fakeTransport();
    wireAuth(fake);
    fake.on("/Items/book-1/UserData", 403, {});
    const ch = await jellyfinConnector.pullProgress!(
      CRED,
      { externalId: "book-1", confidence: 1, externalEdition: "1000000" },
      fake.transport,
      0,
    );
    expect(ch).toBeNull();

    fake.on("/UserData", 403, {});
    const push = await jellyfinConnector.push(
      CRED,
      { externalId: "book-1", confidence: 1, externalEdition: "1000000" },
      {
        kind: "progress",
        document: DOC,
        percentage: 0.5,
        progress: "p",
        position: null,
        timestamp: 1_700_000_000,
      },
      fake.transport,
    );
    expect(push.ok).toBe(false);
    if (push.ok) throw new Error("expected push failure");
    expect(push.needsReauth).toBeFalsy();
    expect(push.error).toBe("forbidden");
  });

  it("pullProgress respects sinceMs", async () => {
    const fake = fakeTransport();
    wireAuth(fake);
    fake.on("/Items/book-1/UserData", 200, {
      PlayedPercentage: 60,
      LastPlayedDate: "2026-06-01T00:00:00.000Z",
    });
    const since = Date.parse("2026-05-01T00:00:00.000Z");
    const ch = await jellyfinConnector.pullProgress!(
      CRED,
      { externalId: "book-1", confidence: 1, externalEdition: "1000000" },
      fake.transport,
      since,
    );
    expect(ch?.percentage).toBe(0.6);
    const stale = await jellyfinConnector.pullProgress!(
      CRED,
      { externalId: "book-1", confidence: 1, externalEdition: "1000000" },
      fake.transport,
      Date.parse("2026-07-01T00:00:00.000Z"),
    );
    expect(stale).toBeNull();
  });
});

describe("jellyfin fan-in", () => {
  it("poller updates canonical progress and fans out to others (not Jellyfin)", async () => {
    const fake = fakeTransport();
    wireAuth(fake);
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const userId = 1;
    await app.request("/api/v1/connectors/jellyfin", {
      method: "PUT",
      headers,
      body: JSON.stringify({ credential: CRED }),
    });
    fake.on("/users/auth", 200, {});
    await app.request("/api/v1/connectors/kosync", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        credential: { server: "mirror.test", username: "u", password: "p" },
      }),
    });
    saveMatch(
      db,
      userId,
      "jellyfin",
      DOC,
      { externalId: "book-1", confidence: 1 },
      "manual",
    );
    await app.request("/syncs/progress", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: "p",
        percentage: 0.2,
        device_id: "reader",
      }),
    });
    fake.on("/Items/book-1/UserData", 200, {
      PlayedPercentage: 60,
      LastPlayedDate: "2030-08-01T12:00:00.000Z",
    });
    db.prepare("DELETE FROM connector_queue").run();

    const applied = await pollConnector(db, userId, "jellyfin", fake.transport);
    expect(applied).toBe(1);

    const got = await (
      await app.request(`/syncs/progress/${DOC}`, { headers })
    ).json();
    expect(got.percentage).toBe(0.6);
    expect(got.device_id).toBe("jellyfin");

    const queued = db
      .prepare("SELECT connector_id FROM connector_queue WHERE user_id = ?")
      .all(userId) as { connector_id: string }[];
    const targets = queued.map((q) => q.connector_id);
    expect(targets).toContain("kosync");
    expect(targets).not.toContain("jellyfin");
  });

  it("maps percentage-only fan-in to a nearby device position, not a far one", async () => {
    const fake = fakeTransport();
    wireAuth(fake);
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const userId = 1;
    await app.request("/api/v1/connectors/jellyfin", {
      method: "PUT",
      headers,
      body: JSON.stringify({ credential: CRED }),
    });
    saveMatch(
      db,
      userId,
      "jellyfin",
      DOC,
      { externalId: "book-1", confidence: 1 },
      "manual",
    );
    const XPOINTER = "/body/DocFragment[11]/body/div[1]/p[3]";
    await app.request("/syncs/progress", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: XPOINTER,
        percentage: 0.38,
        device_id: "kindle",
      }),
    });
    fake.on("/Items/book-1/UserData", 200, {
      PlayedPercentage: 62,
      LastPlayedDate: "2030-09-01T00:00:00.000Z",
    });
    db.prepare("DELETE FROM connector_queue").run();
    expect(await pollConnector(db, userId, "jellyfin", fake.transport)).toBe(1);

    let got = await (
      await app.request(`/syncs/progress/${DOC}`, { headers })
    ).json();
    expect(got.percentage).toBe(0.62);
    expect(got.progress).toBe("jellyfin:620000");

    const NEAR = "/body/DocFragment[20]/body/p[7]";
    await app.request("/syncs/progress", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: NEAR,
        percentage: 0.652,
        device_id: "kindle",
      }),
    });
    fake.on("/Items/book-1/UserData", 200, {
      PlayedPercentage: 65.5,
      LastPlayedDate: "2030-10-01T00:00:00.000Z",
    });
    expect(await pollConnector(db, userId, "jellyfin", fake.transport)).toBe(1);
    got = await (
      await app.request(`/syncs/progress/${DOC}`, { headers })
    ).json();
    expect(got.percentage).toBe(0.655);
    expect(got.progress).toBe(NEAR);
  });
});
