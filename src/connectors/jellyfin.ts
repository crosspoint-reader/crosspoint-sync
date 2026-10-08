import { createHash } from "node:crypto";
import { baseUrl } from "./audiobookshelf.js";
import { decideMatch, extractTitleAuthor, type Candidate } from "./matching.js";
import {
  ConnectorOperationError,
  type Connector,
  type Credential,
  type DocumentMeta,
  type ExternalBook,
  type HttpTransport,
  type InboundChange,
  type Match,
  type OutboundEvent,
  type PushResult,
  type ValidateResult,
} from "./types.js";

interface JellyfinCred extends Credential {
  server: string;
  username: string;
  password: string;
}

interface Session {
  accessToken: string;
  userId: string;
}

const CLIENT = "CrossPoint Sync";
const CLIENT_VERSION = "1.0";

function parseCred(cred: Credential): JellyfinCred | null {
  const server = typeof cred.server === "string" ? cred.server.trim() : "";
  const username =
    typeof cred.username === "string" ? cred.username.trim() : "";
  const password = typeof cred.password === "string" ? cred.password : "";
  if (!server || !username || !password) return null;
  return { server, username, password };
}

function deviceId(c: JellyfinCred): string {
  return createHash("sha256")
    .update(`${baseUrl(c.server)}\n${c.username}`)
    .digest("hex")
    .slice(0, 32);
}

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `MediaBrowser Token="${token}"`,
    "content-type": "application/json",
  };
}

function clientAuthorization(c: JellyfinCred): string {
  const id = deviceId(c);
  return `MediaBrowser Client="${CLIENT}", Device="${CLIENT}", DeviceId="${id}", Version="${CLIENT_VERSION}"`;
}

function loginHeaders(c: JellyfinCred): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    authorization: clientAuthorization(c),
  };
}

const sessions = new Map<string, Session>();
const sessionKey = (c: JellyfinCred) =>
  `${baseUrl(c.server)}\n${c.username}\n${c.password}`;

function versionAtLeast(
  version: string,
  major: number,
  minor: number,
  patch: number,
): boolean {
  const core = (version.trim().split(/[-+~]/)[0] ?? "").split(".");
  const m = Number.parseInt(core[0] ?? "", 10);
  const n = Number.parseInt(core[1] ?? "", 10);
  const p = Number.parseInt(core[2] ?? "", 10);
  const maj = Number.isFinite(m) ? m : 0;
  const min = Number.isFinite(n) ? n : 0;
  const pat = Number.isFinite(p) ? p : 0;
  if (maj !== major) return maj > major;
  if (min !== minor) return min > minor;
  return pat >= patch;
}

async function login(http: HttpTransport, c: JellyfinCred): Promise<Session> {
  const key = sessionKey(c);
  const cached = sessions.get(key);
  if (cached) return cached;

  const res = await http(`${baseUrl(c.server)}/Users/AuthenticateByName`, {
    method: "POST",
    headers: loginHeaders(c),
    body: JSON.stringify({ Username: c.username, Pw: c.password }),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorOperationError(
      "invalid Jellyfin username or password",
      false,
      true,
    );
  }
  if (res.status === 429)
    throw new ConnectorOperationError("Jellyfin rate limited login", true);
  if (res.status === 400) {
    throw new ConnectorOperationError(
      "Jellyfin rejected the login (check the server URL and use Jellyfin 12.0 or newer)",
      false,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ConnectorOperationError(
      `Jellyfin login failed (${res.status})`,
      res.status >= 500,
    );
  }
  const accessToken =
    typeof body?.AccessToken === "string" ? body.AccessToken : "";
  const userId = typeof body?.User?.Id === "string" ? body.User.Id : "";
  if (!accessToken || !userId)
    throw new ConnectorOperationError("Jellyfin returned no session", false);
  const session = { accessToken, userId };
  sessions.set(key, session);
  return session;
}

async function call(
  http: HttpTransport,
  c: JellyfinCred,
  method: string,
  path: string,
  body?: unknown,
) {
  for (let attempt = 0; ; attempt++) {
    const session = await login(http, c);
    const res = await http(`${baseUrl(c.server)}${path}`, {
      method,
      headers: authHeaders(session.accessToken),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if ((res.status !== 401 && res.status !== 403) || attempt > 0)
      return { res, session };
    sessions.delete(sessionKey(c));
  }
}

async function getJson(
  http: HttpTransport,
  c: JellyfinCred,
  path: string,
): Promise<any> {
  const { res } = await call(http, c, "GET", path);
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorOperationError("Jellyfin session expired", false, true);
  }
  if (res.status < 200 || res.status >= 300) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Map Jellyfin UserItemData to a fan-in change; null when there is no trustworthy timestamp. */
export function userDataToInbound(
  externalId: string,
  userData: Record<string, unknown> | null | undefined,
  runTimeTicks: number | null | undefined,
): InboundChange | null {
  const last = userData?.LastPlayedDate;
  if (typeof last !== "string" || !last) return null;
  const updatedAtMs = Date.parse(last);
  if (!Number.isFinite(updatedAtMs)) return null;

  let pct = 0;
  const playedPct = userData?.PlayedPercentage;
  if (typeof playedPct === "number" && Number.isFinite(playedPct)) {
    pct = playedPct / 100;
  } else if (typeof runTimeTicks === "number" && runTimeTicks > 0) {
    const ticks = userData?.PlaybackPositionTicks;
    if (typeof ticks === "number" && Number.isFinite(ticks))
      pct = ticks / runTimeTicks;
  }
  pct = Math.max(0, Math.min(1, pct));
  const finished = userData?.Played === true || pct >= 0.999;
  return { externalId, percentage: finished ? 1 : pct, finished, updatedAtMs };
}

function itemAuthor(item: Record<string, unknown>): string | undefined {
  const people = Array.isArray(item.People) ? item.People : [];
  const names: string[] = [];
  for (const p of people) {
    if (!p || typeof p !== "object") continue;
    const person = p as Record<string, unknown>;
    const role = String(person.Role ?? person.Type ?? "").toLowerCase();
    if (!role.includes("writer") && !role.includes("author")) continue;
    if (typeof person.Name === "string" && person.Name) names.push(person.Name);
  }
  if (names.length) return names.join(", ");
  const artists = item.Artists;
  if (Array.isArray(artists) && typeof artists[0] === "string")
    return artists[0];
  return undefined;
}

function itemToCandidate(item: Record<string, unknown>): Candidate | null {
  const id = item.Id;
  const title = item.Name;
  if (id == null || typeof title !== "string") return null;
  return { externalId: String(id), title, author: itemAuthor(item) };
}

function itemsFromQuery(body: unknown): Record<string, unknown>[] {
  const items = (body as { Items?: unknown })?.Items;
  return Array.isArray(items)
    ? (items.filter((x) => x && typeof x === "object") as Record<
        string,
        unknown
      >[])
    : [];
}

async function validate(
  cred: Credential,
  http: HttpTransport,
): Promise<ValidateResult> {
  const c = parseCred(cred);
  if (!c)
    return {
      ok: false,
      error: "server URL, username and password are required",
    };
  try {
    sessions.delete(sessionKey(c));
    await login(http, c);
    const info = await getJson(http, c, "/System/Info");
    const version = typeof info?.Version === "string" ? info.Version : "";
    if (!versionAtLeast(version, 12, 0, 0)) {
      return { ok: false, error: "Requires Jellyfin 12.0 or newer" };
    }
    return { ok: true, accountLabel: `${c.username} @ ${c.server}` };
  } catch (err) {
    if (err instanceof ConnectorOperationError && err.needsReauth) {
      return { ok: false, error: err.message };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function searchBooks(
  http: HttpTransport,
  c: JellyfinCred,
  query: string,
): Promise<(Candidate & { runTimeTicks?: number })[]> {
  const { userId } = await login(http, c);
  const q = encodeURIComponent(query);
  const path = `/Users/${encodeURIComponent(userId)}/Items?Recursive=true&IncludeItemTypes=Book&SearchTerm=${q}&Fields=People,RunTimeTicks&Limit=25`;
  const body = await getJson(http, c, path);
  const out: (Candidate & { runTimeTicks?: number })[] = [];
  for (const item of itemsFromQuery(body)) {
    const cand = itemToCandidate(item);
    if (!cand) continue;
    const rt = item.RunTimeTicks;
    out.push(
      typeof rt === "number" && rt > 0 ? { ...cand, runTimeTicks: rt } : cand,
    );
  }
  return out;
}

async function match(
  cred: Credential,
  doc: DocumentMeta,
  http: HttpTransport,
): Promise<Match | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const ta = extractTitleAuthor(doc);
  if (!ta) return null;
  const candidates = await searchBooks(http, c, ta.title.trim());
  if (candidates.length === 0) return null;
  const decision = decideMatch(ta.title, ta.author, candidates);
  if (!decision.accepted || !decision.best) return null;
  const chosen = candidates.find(
    (x) => x.externalId === decision.best!.externalId,
  );
  return {
    externalId: decision.best.externalId,
    externalEdition:
      chosen?.runTimeTicks != null ? String(chosen.runTimeTicks) : null,
    confidence: decision.best.score,
    queryUsed: ta.title.trim(),
    title: chosen?.title ?? null,
    author: chosen?.author ?? null,
  };
}

async function listCurrentlyReading(
  cred: Credential,
  http: HttpTransport,
): Promise<ExternalBook[]> {
  const c = parseCred(cred);
  if (!c) return [];
  const session = await login(http, c);
  const path = `/UserItems/Resume?UserId=${encodeURIComponent(session.userId)}&IncludeItemTypes=Book&Fields=People,RunTimeTicks&Limit=50`;
  const body = await getJson(http, c, path);
  const out: ExternalBook[] = [];
  for (const item of itemsFromQuery(body)) {
    const cand = itemToCandidate(item);
    if (!cand) continue;
    const rt = item.RunTimeTicks;
    out.push({
      externalId: cand.externalId,
      title: cand.title,
      author: cand.author ?? null,
      edition: typeof rt === "number" && rt > 0 ? String(rt) : null,
    });
  }
  return out;
}

async function search(
  cred: Credential,
  query: string,
  http: HttpTransport,
): Promise<ExternalBook[]> {
  const c = parseCred(cred);
  if (!c || !query.trim()) return [];
  const candidates = await searchBooks(http, c, query.trim());
  return candidates.map((cand) => ({
    externalId: cand.externalId,
    title: cand.title,
    author: cand.author ?? null,
    edition: cand.runTimeTicks != null ? String(cand.runTimeTicks) : null,
  }));
}

async function fetchRunTimeTicks(
  http: HttpTransport,
  c: JellyfinCred,
  session: Session,
  externalId: string,
): Promise<number | null> {
  const body = await getJson(
    http,
    c,
    `/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(externalId)}?Fields=RunTimeTicks`,
  );
  const rt = body?.RunTimeTicks;
  return typeof rt === "number" && rt > 0 ? rt : null;
}

async function resolveRunTimeTicks(
  http: HttpTransport,
  c: JellyfinCred,
  session: Session,
  m: Match,
): Promise<number | null> {
  const cached = m.externalEdition ? Number(m.externalEdition) : NaN;
  if (Number.isFinite(cached) && cached > 0) return cached;
  return fetchRunTimeTicks(http, c, session, m.externalId);
}

async function resolveEdition(
  cred: Credential,
  externalId: string,
  http: HttpTransport,
): Promise<string | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const session = await login(http, c);
  const rt = await fetchRunTimeTicks(http, c, session, externalId);
  return rt != null ? String(rt) : null;
}

async function pullProgress(
  cred: Credential,
  m: Match,
  http: HttpTransport,
  sinceMs: number,
): Promise<InboundChange | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const session = await login(http, c);
  const ud = await getJson(
    http,
    c,
    `/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(m.externalId)}/UserData`,
  );
  if (!ud) return null;
  const playedPct = ud.PlayedPercentage;
  const hasPct = typeof playedPct === "number" && Number.isFinite(playedPct);
  const runTimeTicks = hasPct
    ? null
    : await resolveRunTimeTicks(http, c, session, m);
  const change = userDataToInbound(m.externalId, ud, runTimeTicks);
  if (!change || change.updatedAtMs <= sinceMs) return null;
  return change;
}

async function push(
  cred: Credential,
  m: Match,
  ev: OutboundEvent,
  http: HttpTransport,
): Promise<PushResult> {
  const c = parseCred(cred);
  if (!c)
    return {
      ok: false,
      retryable: false,
      needsReauth: true,
      error: "bad credential",
    };
  const session = await login(http, c);
  const itemPath = `/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(m.externalId)}`;

  const getRes = await call(http, c, "GET", `${itemPath}/UserData`);
  if (getRes.res.status === 401 || getRes.res.status === 403) {
    return {
      ok: false,
      retryable: false,
      needsReauth: true,
      error: "unauthorized",
    };
  }
  let remote: Record<string, unknown> | null = null;
  if (getRes.res.status >= 200 && getRes.res.status < 300) {
    try {
      remote = (await getRes.res.json()) as Record<string, unknown>;
    } catch {
      remote = null;
    }
  }
  const remoteLast = remote?.LastPlayedDate;
  if (typeof remoteLast === "string" && remoteLast) {
    const remoteMs = Date.parse(remoteLast);
    if (
      Number.isFinite(remoteMs) &&
      Math.floor(remoteMs / 1000) > ev.timestamp
    ) {
      return { ok: true };
    }
  }

  const pct = Math.max(0, Math.min(1, ev.percentage ?? 0));
  const finished = ev.kind === "finished" || pct >= 0.999;
  const runTimeTicks = await resolveRunTimeTicks(http, c, session, m);
  const playedPct = finished ? 100 : pct * 100;
  const payload: Record<string, unknown> = {
    PlayedPercentage: playedPct,
    Played: finished,
    LastPlayedDate: new Date(ev.timestamp * 1000).toISOString(),
  };
  if (runTimeTicks) {
    payload.PlaybackPositionTicks = Math.round(
      (finished ? 1 : pct) * runTimeTicks,
    );
  }

  const postRes = await call(http, c, "POST", `${itemPath}/UserData`, payload);
  if (postRes.res.status === 401 || postRes.res.status === 403) {
    return {
      ok: false,
      retryable: false,
      needsReauth: true,
      error: "unauthorized",
    };
  }
  if (postRes.res.status === 429)
    return { ok: false, retryable: true, error: "rate limited" };
  if (postRes.res.status >= 500)
    return {
      ok: false,
      retryable: true,
      error: `server ${postRes.res.status}`,
    };
  if (postRes.res.status >= 200 && postRes.res.status < 300)
    return { ok: true };
  return {
    ok: false,
    retryable: false,
    error: `unexpected status ${postRes.res.status}`,
  };
}

export const jellyfinConnector: Connector = {
  id: "jellyfin",
  displayName: "Jellyfin",
  tier: 1,
  capabilities: { read: true, write: true },
  carries: ["progress", "finished"],
  credentialKind: "jellyfin",
  beta: true,
  validate,
  match,
  push,
  listCurrentlyReading,
  search,
  resolveEdition,
  pullProgress,
};
