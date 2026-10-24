import { createAiEngine } from '../client';
import type { BgRequest, BgResult } from './worker';

export type { BgRequest, BgResult };

// One worker for the page, started with the first photo and kept for the next (and for re-composing the last one).
// Jobs run one at a time.
export const bgEngine = createAiEngine<BgRequest, BgResult>(
  () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
);
