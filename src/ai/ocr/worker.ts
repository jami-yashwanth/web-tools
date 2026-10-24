import type { AiWorkerRequest, AiWorkerResponse } from '../client';
import { MODELS, modelUrl } from '../config';
import { AiError, reasonOf } from '../errors';
import { evictModel, loadModel } from '../loader';
import { assertTraineddata, recogniseBytes, type OcrResult } from './core';

// The OCR worker. Answers each job with progress messages, then one done or failed (the protocol in ../client.ts).
// The language data comes through our loader (progress, Cache Storage, eviction); tesseract's own worker script and
// core are files of this build, not a CDN's.

export interface OcrRequest {
  image: ArrayBuffer;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<AiWorkerRequest<OcrRequest>>) => void) | null;
  postMessage(message: AiWorkerResponse<OcrResult>, transfer?: Transferable[]): void;
  location: { href: string };
};

// Probe for WebAssembly SIMD: a module with one v128 instruction validates only where SIMD exists.
// prettier-ignore
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

/** URLs of tesseract's worker script and of the core build this browser can run (SIMD or not). Both ship in `dist`. */
async function tesseractFiles(): Promise<{ workerPath: string; corePath: string }> {
  const [worker, core] = await Promise.all([
    import('tesseract.js/dist/worker.min.js?url'),
    WebAssembly.validate(SIMD_PROBE)
      ? import('tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url')
      : import('tesseract.js-core/tesseract-core-lstm.wasm.js?url'),
  ]);
  const absolute = (url: string) => new URL(url, scope.location.href).href;
  return { workerPath: absolute(worker.default), corePath: absolute(core.default) };
}

/** URLs whose bytes already passed assertTraineddata in this worker: a repeat job reads them without unpacking again. */
const validated = new Set<string>();

async function run(req: OcrRequest, progress: (stage: 'download' | 'work', done: number, total: number) => void): Promise<OcrResult> {
  const url = modelUrl('tessdata');
  const model = new Uint8Array(
    await loadModel(url, { bytes: MODELS.tessdata.bytes, onProgress: (done, total) => progress('download', done, total) }),
  );
  try {
    if (!validated.has(url)) await assertTraineddata(model);
    validated.add(url);
  } catch (err) {
    await evictModel(url); // a bad cache entry must not be served again
    throw err;
  }
  progress('work', 0, 100); // core and language data take a moment to start: show 0%, not a bare verb
  // tesseract fetches `<langPath>/eng.traineddata.gz`; the fragment keeps that suffix off the blob's own name.
  const blobUrl = URL.createObjectURL(new Blob([model as BlobPart]));
  try {
    return await recogniseBytes(req.image, { ...(await tesseractFiles()), langPath: `${blobUrl}#` }, (done, total) =>
      progress('work', done, total),
    );
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

scope.onmessage = async (e) => {
  const { id, req } = e.data;
  try {
    const result = await run(req, (stage, done, total) => scope.postMessage({ kind: 'progress', id, stage, done, total }));
    scope.postMessage({ kind: 'done', id, result });
  } catch (err) {
    if (!(err instanceof AiError)) console.error('ocr worker: unexpected error', err);
    scope.postMessage({
      kind: 'failed',
      id,
      reason: reasonOf(err),
      ...(err instanceof AiError && err.badModel ? { badModel: true } : {}),
      ...(err instanceof AiError && err.detectedType ? { detectedType: err.detectedType } : {}),
    });
  }
};
