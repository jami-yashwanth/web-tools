import { CodecLoadError } from '../../engine/codecs';
import { DecodeError, decode, type Pixels } from '../../engine/decode';
import { applyOrientation } from '../../engine/pixels';
import { sniff } from '../../engine/sniff';
import type { AiWorkerRequest, AiWorkerResponse } from '../client';
import { encodePng, encodePreview } from '../encode';
import { AiError, reasonOf } from '../errors';
import { isOutOfMemory, loadFiles, startRuntime, type Ort, type Progress, type Session } from '../ort/runtime';
import { MODEL_SCALE, OVERLAP, Stitcher, TILE, fitsOutput, planTiles, tileInput, tileToRgba, type Rect, type Scale } from './tiles';

// The Upscale image worker. A job decodes the image (upright), checks the result will fit the 16 MP cap, then runs
// realesr-general-x4v3 (×4) with onnxruntime-web's WebAssembly backend on 128 px tiles, one at a time, each written
// into the one output buffer as it comes (halved first for 2×). It answers with the PNG and a small preview of the
// image. Protocol: ../client.ts.

export interface UpscaleRequest {
  image: ArrayBuffer;
  scale: Scale;
}

export interface UpscaleResult {
  png: ArrayBuffer;
  /** The upright image, long edge at most 2048 px, as a JPEG (the "before" of the comparison). */
  preview: ArrayBuffer;
  /** The upscaled image's size. */
  width: number;
  height: number;
  hasAlpha: boolean;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<AiWorkerRequest<UpscaleRequest>>) => void) | null;
  postMessage(message: AiWorkerResponse<UpscaleResult>, transfer?: Transferable[]): void;
};

// --- the runtime and the model session, kept for the next image ---

let runtime: { ort: Ort; session: Session } | null = null;
/** Stub builds load the files but never start the runtime: this records that they are in. */
let stubLoaded = false;

/** Download (first use) and start the model. */
async function ready(progress: Progress): Promise<void> {
  if (runtime || stubLoaded) return;
  const { wasm, model } = await loadFiles('upscale', progress);
  if (import.meta.env.PUBLIC_AI_STUB === '1') {
    const { isStubBadModel } = await import('../stub');
    if (isStubBadModel(model)) throw new AiError('network', { badModel: true });
    stubLoaded = true;
    return;
  }
  progress('work', 0, 100);
  runtime = await startRuntime(wasm, model);
}

/** The model's ×4 output for one tile: planar RGB, nominally 0..1. */
async function infer(input: Float32Array, r: Rect): Promise<Float32Array> {
  if (import.meta.env.PUBLIC_AI_STUB === '1') {
    const { stubUpscale } = await import('../stub');
    return stubUpscale(input, r.w, r.h, MODEL_SCALE);
  }
  const { ort, session } = runtime!;
  const feeds = { [session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, r.h, r.w]) };
  const out = await session.run(feeds);
  const result = new Float32Array(out[session.outputNames[0]!]!.data as Float32Array);
  for (const t of Object.values(out)) t.dispose();
  return result;
}

async function upscale({ image, scale }: UpscaleRequest, progress: Progress): Promise<UpscaleResult> {
  const header = await sniff(new Blob([image]));
  if (header.type === 'unknown') throw new AiError('wrong-type');
  // The size from the file's header first: an image too large to upscale fails before it is decoded at all.
  if (header.width && header.height && !fitsOutput(header.width, header.height, scale)) throw new AiError('too-large');
  // Decode and check before any download: a damaged image fails at once, not after the model arrives.
  let pixels: Pixels;
  try {
    pixels = applyOrientation(await decode(image, header.type));
  } catch (err) {
    // Too large to even hold in memory decoded: far over the cap whatever its header said.
    throw isOutOfMemory(err) ? new AiError('too-large') : err;
  }
  const { width: w, height: h } = pixels;
  if (!fitsOutput(w, h, scale)) throw new AiError('too-large');
  await ready(progress);

  // The small preview first, so it is never made while the full-size output is held as well.
  const preview = await encodePreview(pixels);
  const png = await upscalePng(pixels, scale, progress);
  return { png, preview, width: w * scale, height: h * scale, hasAlpha: pixels.hasAlpha };
}

/** Run the tiles one at a time into one output buffer, and encode it. The buffer is dropped on return. */
async function upscalePng(pixels: Pixels, scale: Scale, progress: Progress): Promise<ArrayBuffer> {
  const { width: w, height: h } = pixels;
  const tiles = planTiles(w, h, TILE, OVERLAP);
  const steps = tiles.length + 1; // the tiles, then the PNG
  progress('work', 0, steps);
  const out = new Stitcher(w, h, scale, OVERLAP);
  for (let i = 0; i < tiles.length; i++) {
    const rect = tiles[i]!;
    out.add(rect, tileToRgba(await infer(tileInput(pixels, rect), rect), pixels, rect, scale));
    progress('work', i + 1, steps);
  }
  const png = await encodePng(out.data, w * scale, h * scale);
  progress('work', steps, steps);
  return png;
}

/** The AiError a failure stands for: decode failures are a damaged image, memory exhaustion is the device. */
function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof CodecLoadError) return new AiError('network');
  if (isOutOfMemory(err)) return new AiError('device');
  if (err instanceof DecodeError) return new AiError('corrupt');
  console.error('upscale worker: unexpected error', err);
  return new AiError('corrupt');
}

scope.onmessage = async (e) => {
  const { id, req } = e.data;
  const progress: Progress = (stage, done, total) => scope.postMessage({ kind: 'progress', id, stage, done, total });
  try {
    const result = await upscale(req, progress);
    scope.postMessage({ kind: 'done', id, result }, [result.png, result.preview]);
  } catch (raw) {
    const err = toAiError(raw);
    scope.postMessage({
      kind: 'failed',
      id,
      reason: reasonOf(err),
      ...(err.badModel ? { badModel: true } : {}),
      ...(err.detectedType ? { detectedType: err.detectedType } : {}),
    });
  }
};
