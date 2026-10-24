import { createAiEngine } from '../client';
import type { WhisperPartial, WhisperRequest, WhisperResult } from './worker';

export type { WhisperPartial, WhisperRequest, WhisperResult };

// One worker for the page, started with the first file and kept (with its pipeline) for the next. Cancel ends it.
export const whisperEngine = createAiEngine<WhisperRequest, WhisperResult>(
  () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
);
