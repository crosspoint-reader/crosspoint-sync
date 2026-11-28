import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeMs, splitAudio } from '../src/connectors/audio-split.js';
import { asrConfigFromEnv, transcribe, type Fetch } from '../src/connectors/asr.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crosspoint-asr-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 130s of tone as uncompressed wav: big enough to look oversized to a chunker. */
async function tone(path: string): Promise<string> {
  execFileSync('ffmpeg', [
    '-nostdin', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=130', '-ac', '1', '-ar', '8000', path,
  ]);
  return path;
}

describe('audio splitting', () => {
  it.skipIf(!hasFfmpeg)('splits a long file into chunks with cumulative offsets', async () => {
    const file = await tone(join(dir, 'book.wav'));
    const chunks = await splitAudio(file, dir, 500_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].offsetMs).toBe(0);
    // Each offset is the sum of the previous chunk durations, i.e. ~66s apart.
    expect(chunks[1].offsetMs).toBeGreaterThan(60_000);
    expect(chunks[1].offsetMs).toBeLessThan(70_000);
    const total = chunks.at(-1)!.offsetMs + await probeMs(chunks.at(-1)!.path);
    expect(total).toBeGreaterThan(125_000);
  });

  it.skipIf(!hasFfmpeg)('transcribes an oversized file chunk by chunk and shifts word times', async () => {
    const file = await tone(join(dir, 'book.wav'));
    const bytes = await readFile(file);
    const posted: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://api.groq.com')) {
        // One word per chunk, one second into that chunk.
        posted.push(url);
        return new Response(JSON.stringify({ words: [{ word: 'hello', start: 1, end: 1.4 }] }), { status: 200 });
      }
      expect(init?.headers).toEqual({ authorization: 'Bearer token' });
      return new Response(new Blob([bytes]), { status: 200, headers: { 'content-length': String(bytes.length) } });
    }) as Fetch;

    const config = { ...asrConfigFromEnv({ GROQ_API_KEY: 'key' }), maxBytes: 500_000 };
    const words = await transcribe(config, { url: 'http://abs:80/api/items/x/file/1', headers: { authorization: 'Bearer token' } }, fakeFetch);

    expect(words).toHaveLength(2);
    expect(words[0]).toMatchObject({ word: 'hello', startMs: 1000, endMs: 1400 });
    // Second chunk's times are shifted by the first chunk's length.
    expect(words[1].startMs).toBeGreaterThan(60_000);
    expect(words[1].startMs).toBeLessThan(70_000);
    expect(posted).toHaveLength(2);
  });

  it.skipIf(!hasFfmpeg)('uploads a file under the cap in one request', async () => {
    const file = await tone(join(dir, 'book.wav'));
    const bytes = await readFile(file);
    let calls = 0;
    const fakeFetch = (async (input: string | URL | Request) => {
      if (String(input).startsWith('https://api.groq.com')) {
        calls++;
        return new Response(JSON.stringify({ words: [{ word: 'hi', start: 0, end: 0.5 }] }), { status: 200 });
      }
      return new Response(new Blob([bytes]), { status: 200 });
    }) as Fetch;

    const config = { ...asrConfigFromEnv({ GROQ_API_KEY: 'key' }), maxBytes: 50 * 1024 * 1024 };
    const words = await transcribe(config, { url: 'http://abs:80/x.m4b', headers: {} }, fakeFetch);
    expect(words).toEqual([{ word: 'hi', startMs: 0, endMs: 500 }]);
    expect(calls).toBe(1);
  });
});
