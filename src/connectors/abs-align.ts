import type { DB } from '../db/db.js';
import { loadAlignment, saveAlignment } from '../models/audio-alignment.js';
import { absAlignmentSource } from './audiobookshelf.js';
import { transcribe, type AsrConfig, type Fetch } from './asr.js';
import { fetchTransport } from './registry.js';
import { decryptCredential, getAccount } from './store.js';
import { ConnectorOperationError, type HttpTransport } from './types.js';
import { alignTranscript, type TranscriptWord } from './word-align.js';

/**
 * Builds and stores word-level alignments for matched Audiobookshelf items:
 * transcribe each audio file, match the transcript against the EPUB text, and
 * save the ebook-offset <-> audio-time mapping the connector then syncs on.
 *
 * Jobs are serialized (one transcode at a time) and retried with backoff, since
 * a book takes minutes to transcribe and the ASR backend may rate limit.
 */

const BACKOFF_SECONDS = [60, 600, 3600, 21600, 86400];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

interface JobRow {
  user_id: number;
  connector_id: string;
  external_id: string;
  document: string;
  attempts: number;
}

/** Queue an alignment for a matched book, unless one already exists or is queued. */
export function enqueueAlignment(
  db: DB,
  userId: number,
  connectorId: string,
  externalId: string,
  document: string,
  now = Date.now()
): void {
  if (connectorId !== 'audiobookshelf' || !externalId) return;
  if (loadAlignment(db, userId, connectorId, externalId)) return;
  const at = Math.floor(now / 1000);
  db.prepare(
    `INSERT INTO audio_align_jobs (user_id, connector_id, external_id, document, status, next_try_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT (user_id, connector_id, external_id) DO UPDATE SET
       document = excluded.document,
       status = CASE WHEN audio_align_jobs.status = 'failed' THEN 'pending' ELSE audio_align_jobs.status END,
       attempts = CASE WHEN audio_align_jobs.status = 'failed' THEN 0 ELSE audio_align_jobs.attempts END,
       next_try_at = CASE WHEN audio_align_jobs.status = 'failed' THEN excluded.next_try_at ELSE audio_align_jobs.next_try_at END,
       updated_at = excluded.updated_at`
  ).run(userId, connectorId, externalId, document, at, at, at);
}

/**
 * Queue alignments for every matched Audiobookshelf book that has none yet, so
 * books matched before this feature existed (or while the worker was down) do
 * not need to be re-matched by hand.
 */
export function enqueueMissing(db: DB, now = Date.now()): void {
  const rows = db.prepare(
    `SELECT user_id, document, external_id FROM connector_matches
     WHERE connector_id = 'audiobookshelf' AND external_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM audio_alignment a
         WHERE a.user_id = connector_matches.user_id
           AND a.connector_id = connector_matches.connector_id
           AND a.external_id = connector_matches.external_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM audio_align_jobs j
         WHERE j.user_id = connector_matches.user_id
           AND j.connector_id = connector_matches.connector_id
           AND j.external_id = connector_matches.external_id
       )`
  ).all() as { user_id: number; document: string; external_id: string }[];
  for (const row of rows) {
    enqueueAlignment(db, row.user_id, 'audiobookshelf', row.external_id, row.document, now);
  }
}

/**
 * Requeue jobs a restart interrupted. `claim` already committed the row as
 * `running`, and `enqueueMissing` never revisits a book that has any job row, so
 * without this an interrupted transcription is never attempted again.
 */
export function recoverRunning(db: DB, now = Date.now()): void {
  const at = Math.floor(now / 1000);
  db.prepare(
    `UPDATE audio_align_jobs SET status = 'pending', next_try_at = ?, updated_at = ? WHERE status = 'running'`
  ).run(at, at);
}

function claim(db: DB, now = Date.now()): JobRow | null {
  const job = db.prepare(
    `SELECT user_id, connector_id, external_id, document, attempts FROM audio_align_jobs
     WHERE status = 'pending' AND next_try_at <= ? ORDER BY next_try_at LIMIT 1`
  ).get(Math.floor(now / 1000)) as JobRow | undefined;
  if (!job) return null;
  db.prepare(
    `UPDATE audio_align_jobs SET status = 'running', updated_at = ?
     WHERE user_id = ? AND connector_id = ? AND external_id = ?`
  ).run(Math.floor(now / 1000), job.user_id, job.connector_id, job.external_id);
  return job;
}

/** Transcribe every audio file, align the transcript with the EPUB, store the mapping. */
export async function runAlignmentJob(
  db: DB,
  config: AsrConfig,
  job: JobRow,
  http: HttpTransport = fetchTransport,
  fetchImpl: Fetch = fetch
): Promise<void> {
  const account = getAccount(db, job.user_id, job.connector_id);
  if (!account) throw new Error(`${job.connector_id} account is no longer linked`);
  // A book takes hours to transcribe: re-check the link between files so an
  // unlink or re-link stops the work instead of paying for the old account and
  // storing a mapping for a credential that no longer exists.
  const unchanged = (): void => {
    const row = getAccount(db, job.user_id, job.connector_id);
    if (!row || !row.enabled || row.cred_enc !== account.cred_enc) {
      throw new ConnectorOperationError(`${job.connector_id} account changed during alignment`, false);
    }
  };
  const source = await absAlignmentSource(decryptCredential(account, db), job.external_id, http);
  const progress = db.prepare(
    `UPDATE audio_align_jobs SET files_total = ?, files_done = ?, updated_at = ?
     WHERE user_id = ? AND connector_id = ? AND external_id = ?`
  );
  progress.run(source.files.length, 0, Math.floor(Date.now() / 1000), job.user_id, job.connector_id, job.external_id);

  const words: TranscriptWord[] = [];
  let startMs = 0;
  for (const [index, file] of source.files.entries()) {
    unchanged();
    const spoken = await transcribe(config, file, fetchImpl);
    for (const word of spoken) {
      words.push({ word: word.word, startMs: startMs + word.startMs, endMs: startMs + word.endMs });
    }
    // Prefer the declared duration: a narrator's trailing silence is real audio.
    startMs += file.durationMs || spoken[spoken.length - 1]?.endMs || 0;
    progress.run(source.files.length, index + 1, Math.floor(Date.now() / 1000), job.user_id, job.connector_id, job.external_id);
  }

  const alignment = alignTranscript(source.spines.join(''), words);
  unchanged();
  saveAlignment(db, job.user_id, job.connector_id, job.external_id, job.document, {
    ...alignment,
    spineLengths: source.spines.map(text => Array.from(text).length),
    durationMs: Math.max(alignment.durationMs, source.durationMs),
    source: config.provider,
  });
}

function finish(db: DB, job: JobRow, error?: unknown, retryable = true): void {
  const now = Math.floor(Date.now() / 1000);
  if (!error) {
    db.prepare(
      `UPDATE audio_align_jobs SET status = 'done', last_error = NULL, updated_at = ?
       WHERE user_id = ? AND connector_id = ? AND external_id = ?`
    ).run(now, job.user_id, job.connector_id, job.external_id);
    return;
  }
  const attempts = job.attempts + 1;
  const message = error instanceof Error ? error.message : String(error);
  const backoff = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
  db.prepare(
    `UPDATE audio_align_jobs SET status = ?, attempts = ?, next_try_at = ?, last_error = ?, updated_at = ?
     WHERE user_id = ? AND connector_id = ? AND external_id = ?`
  ).run(
    retryable && attempts < MAX_ATTEMPTS ? 'pending' : 'failed',
    attempts, now + backoff, message.slice(0, 500), now,
    job.user_id, job.connector_id, job.external_id
  );
}

/**
 * Say so once at startup when nothing can transcribe, rather than letting each
 * queued book fail its way through the backoff schedule.
 */
async function checkTranscriber(config: AsrConfig): Promise<void> {
  const warn = (msg: string, extra: Record<string, unknown> = {}): void => {
    console.warn(JSON.stringify({ msg, provider: config.provider, ...extra }));
  };
  if (config.provider === 'groq') {
    if (!config.apiKey) warn('word-level alignment cannot run: GROQ_API_KEY is not set');
    return;
  }
  try {
    const res = await fetch(`${config.url}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (error) {
    warn('word-level alignment cannot run: no local transcriber answers; set GROQ_API_KEY or run the aligner sidecar', {
      url: config.url, error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Drain ready alignment jobs in the background. One at a time: transcription is
 * CPU- and quota-heavy, and a partially transcribed book retries from scratch.
 */
export function startAlignWorker(
  db: DB,
  config: AsrConfig,
  intervalMs = 60_000,
  http: HttpTransport = fetchTransport
): void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (let job = claim(db); job; job = claim(db)) {
        try {
          await runAlignmentJob(db, config, job, http);
          finish(db, job);
        } catch (error) {
          // An audio-only item has no EPUB to align against: retrying for a day
          // only burns quota.
          finish(db, job, error, !(error instanceof ConnectorOperationError) || error.retryable);
          console.error(JSON.stringify({
            msg: 'audio alignment failed', connector: job.connector_id, item: job.external_id,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    } finally {
      running = false;
    }
  };
  void checkTranscriber(config);
  recoverRunning(db);
  void enqueueMissing(db);
  void tick();
  setInterval(() => void tick(), intervalMs).unref();
}
