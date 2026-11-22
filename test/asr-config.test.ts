import { expect, it } from 'vitest';
import { asrConfigFromEnv } from '../src/connectors/asr.js';

const GROQ_MAX_BYTES = 100 * 1024 * 1024;

it('falls back to the default upload cap when ASR_MAX_BYTES is empty or junk', () => {
  // Number('') is 0 and Number('abc') is NaN; either would break ffmpeg chunking.
  expect(asrConfigFromEnv({ ASR_MAX_BYTES: '' }).maxBytes).toBe(GROQ_MAX_BYTES);
  expect(asrConfigFromEnv({ ASR_MAX_BYTES: 'abc' }).maxBytes).toBe(GROQ_MAX_BYTES);
  expect(asrConfigFromEnv({}).maxBytes).toBe(GROQ_MAX_BYTES);
  expect(asrConfigFromEnv({ ASR_MAX_BYTES: '1000' }).maxBytes).toBe(1000);
});
