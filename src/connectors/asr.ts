import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { splitAudio } from './audio-split.js';
import type { TranscriptWord } from './word-align.js';

/**
 * Speech-to-text backends. Both return word timestamps; matching the words to
 * the book happens here in TypeScript, so the local aligner stays a thin
 * "audio in, timestamps out" service and the hosted path needs no sidecar.
 */
export interface AsrConfig {
  provider: 'local' | 'groq';
  /** Local aligner base URL (`ASR_URL`). */
  url: string;
  /** Groq API key (`GROQ_API_KEY`). */
  apiKey: string;
  /** Groq transcription model (`ASR_MODEL`). */
  model: string;
  /** Refuse files larger than this: the hosted API caps uploads. */
  maxBytes: number;
}

export interface AsrSource {
  url: string;
  headers: Record<string, string>;
}

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MAX_BYTES = 100 * 1024 * 1024;
// Sanity cap on what we are willing to write to disk before splitting.
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;

export function asrConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AsrConfig {
  const apiKey = env.GROQ_API_KEY ?? '';
  const provider = env.ASR_PROVIDER === 'local' || env.ASR_PROVIDER === 'groq'
    ? env.ASR_PROVIDER
    : apiKey ? 'groq' : 'local';
  return {
    provider,
    url: (env.ASR_URL ?? 'http://aligner:8080').replace(/\/+$/, ''),
    apiKey,
    model: env.ASR_MODEL ?? 'whisper-large-v3',
    maxBytes: Number(env.ASR_MAX_BYTES ?? GROQ_MAX_BYTES),
  };
}

export type Fetch = typeof fetch;

/**
 * Times for every word in one audio file, relative to that file's start.
 * Throws with an actionable message when the file cannot be transcribed.
 */
export async function transcribe(
  config: AsrConfig,
  source: AsrSource,
  fetchImpl: Fetch = fetch
): Promise<TranscriptWord[]> {
  if (config.provider === 'groq') return transcribeGroq(config, source, fetchImpl);
  return transcribeLocal(config, source, fetchImpl);
}

async function transcribeLocal(
  config: AsrConfig, source: AsrSource, fetchImpl: Fetch
): Promise<TranscriptWord[]> {
  const response = await fetchImpl(`${config.url}/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: source.url, headers: source.headers }),
  });
  if (!response.ok) {
    throw new Error(`aligner failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }
  const body = (await response.json()) as { words?: { word?: string; start_ms?: number; end_ms?: number }[] };
  return (body.words ?? [])
    .map(w => ({ word: w.word ?? '', startMs: Number(w.start_ms) || 0, endMs: Number(w.end_ms) || 0 }))
    .filter(w => w.word && w.endMs > w.startMs);
}

async function transcribeGroq(
  config: AsrConfig, source: AsrSource, fetchImpl: Fetch
): Promise<TranscriptWord[]> {
  if (!config.apiKey) throw new Error('GROQ_API_KEY is not set; set it or use ASR_PROVIDER=local');
  const dir = await mkdtemp(join(tmpdir(), 'crosspoint-asr-'));
  try {
    const file = join(dir, 'source');
    const size = await downloadTo(source, file, fetchImpl);
    if (size <= config.maxBytes) {
      return postGroq(config, await readFile(file), fileName(source.url), fetchImpl);
    }
    // An audiobook chapter fits, a 20-hour m4b does not: split so the hosted
    // API sees several small uploads instead of refusing the book.
    const words: TranscriptWord[] = [];
    for (const chunk of await splitAudio(file, dir, config.maxBytes)) {
      const bytes = await readFile(chunk.path);
      if (bytes.byteLength > config.maxBytes) throw tooBig(bytes.byteLength, config.maxBytes);
      for (const word of await postGroq(config, bytes, 'audio.mp3', fetchImpl)) {
        words.push({ ...word, startMs: word.startMs + chunk.offsetMs, endMs: word.endMs + chunk.offsetMs });
      }
    }
    return words;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function postGroq(
  config: AsrConfig, bytes: Uint8Array, name: string, fetchImpl: Fetch
): Promise<TranscriptWord[]> {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), name);
  form.set('model', config.model);
  form.set('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  const response = await fetchImpl(GROQ_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Groq transcription failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const body = (await response.json()) as { words?: { word?: string; start?: number; end?: number }[] };
  if (!body.words?.length) {
    throw new Error(`Groq returned no word timestamps for ${name}; model ${config.model} must support timestamp_granularities=word`);
  }
  return body.words
    .map(w => ({ word: w.word ?? '', startMs: Math.round((w.start ?? 0) * 1000), endMs: Math.round((w.end ?? 0) * 1000) }))
    .filter(w => w.word && w.endMs > w.startMs);
}

/** Streams the audio to disk (an audiobook must not sit in memory) and returns its size. */
async function downloadTo(source: AsrSource, file: string, fetchImpl: Fetch): Promise<number> {
  const response = await fetchImpl(source.url, { headers: source.headers });
  if (!response.ok || !response.body) throw new Error(`audio download failed (${response.status})`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw tooBig(declared, MAX_DOWNLOAD_BYTES);
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > MAX_DOWNLOAD_BYTES ? tooBig(size, MAX_DOWNLOAD_BYTES) : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), counter, createWriteStream(file));
  return size;
}

function fileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'audio.mp3');
  } catch {
    return 'audio.mp3';
  }
}

function tooBig(size: number, max: number): Error {
  const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MiB`;
  return new Error(
    `audio file is ${mb(size)}, over the ${mb(max)} transcription limit; install ffmpeg so it can be split, or split the audiobook into files in Audiobookshelf`
  );
}
