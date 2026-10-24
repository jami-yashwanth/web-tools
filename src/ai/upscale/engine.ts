import { createAiEngine } from '../client';
import type { UpscaleRequest, UpscaleResult } from './worker';

export type { UpscaleRequest, UpscaleResult };

// One worker for the page, started with the first image and kept (with its model session) for the next.
export const upscaleEngine = createAiEngine<UpscaleRequest, UpscaleResult>(
  () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
);
