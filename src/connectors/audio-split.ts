import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Whisper downsamples to 16 kHz mono, so a 48 kbps mono mp3 carries all the
// signal it uses and the uploaded chunk is a fraction of the original size.
const CHUNK_BITRATE = 48_000;
// Leave headroom under the provider cap for container overhead.
const CHUNK_FILL = 0.8;

export interface AudioChunk {
  path: string;
  offsetMs: number;
}

/** Duration of an audio or video file in milliseconds. */
export async function probeMs(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe found no duration in ${path}`);
  return Math.round(seconds * 1000);
}

/**
 * Re-encode one audio file into mp3 chunks that fit under `maxBytes`, with the
 * start offset of each chunk so word times stay relative to the whole file.
 */
export async function splitAudio(path: string, dir: string, maxBytes: number): Promise<AudioChunk[]> {
  // ponytail: a 1s floor keeps any cap workable; a cap under ~6 KB still fails,
  // but the error says so instead of emitting a chunk the provider refuses.
  const chunkSeconds = Math.max(1, Math.floor((maxBytes * CHUNK_FILL * 8) / CHUNK_BITRATE));
  await ffmpeg([
    '-nostdin', '-loglevel', 'error', '-i', path,
    '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'libmp3lame', '-b:a', `${CHUNK_BITRATE / 1000}k`,
    '-f', 'segment', '-segment_time', String(chunkSeconds), '-reset_timestamps', '1',
    join(dir, 'chunk%04d.mp3'),
  ]);
  const parts = (await readdir(dir)).filter(n => n.startsWith('chunk') && n.endsWith('.mp3')).sort();
  if (!parts.length) throw new Error(`ffmpeg produced no audio chunks for ${path}`);
  const chunks: AudioChunk[] = [];
  let offsetMs = 0;
  for (const part of parts) {
    chunks.push({ path: join(dir, part), offsetMs });
    offsetMs += await probeMs(join(dir, part));
  }
  return chunks;
}

async function ffmpeg(args: string[]): Promise<void> {
  try {
    await run('ffmpeg', args);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error('ffmpeg is not installed, so this audiobook cannot be split for the hosted transcriber; install ffmpeg or set ASR_PROVIDER=local (the aligner sidecar splits its own downloads)');
    }
    throw error;
  }
}
