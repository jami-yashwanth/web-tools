import { createAiEngine, type AiProgress } from '../client';
import type { OcrResult } from './core';
import type { OcrRequest } from './worker';

export type { OcrResult };

// One worker for the page, started with the first image and kept for the next. Jobs run one at a time.
const engine = createAiEngine<OcrRequest, OcrResult>(() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));

/**
 * Read the text in an image: its EXIF orientation is applied first. Downloads the language data on first use
 * (reported as `download` progress), then reports `work` progress. Rejects with an AiError.
 */
export async function recognise(image: Blob, onProgress: (p: AiProgress) => void, signal?: AbortSignal): Promise<OcrResult> {
  const bytes = await image.arrayBuffer();
  return engine.run({ image: bytes }, [bytes], onProgress, signal);
}
