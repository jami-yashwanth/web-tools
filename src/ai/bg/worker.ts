import { CodecLoadError } from '../../engine/codecs';
import { DecodeError, decode, type Pixels } from '../../engine/decode';
import { sniff } from '../../engine/sniff';
import type { AiWorkerRequest, AiWorkerResponse } from '../client';
import { encodePng, encodePreview } from '../encode';
import { AiError, reasonOf } from '../errors';
import { isOutOfMemory, loadFiles, startRuntime, type Ort, type Progress, type Session } from '../ort/runtime';
import { MODEL_SIZE, composeRGBA, normaliseMask, prepareInput, toModelInput, upsampleMask, type Background } from './compose';

// The Remove background worker. A `remove` job decodes the photo (upright, at most 25 MP), runs u2netp on it with
// onnxruntime-web's WebAssembly backend, and answers with a transparent PNG and a small preview of the photo. The
// photo and the model's 320² mask stay here, so a `compose` job can put the cut-out on another background without
// running the model again. Protocol: ../client.ts.

export type BgRequest = { op: 'remove'; image: ArrayBuffer } | { op: 'compose'; bg: Background };

export interface BgResult {
  png: ArrayBuffer;
  /** `remove` only: the upright photo, long edge at most 2048 px, as a JPEG (the "before" of the comparison). */
  preview?: ArrayBuffer;
  width: number;
  height: number;
  /** The photo was over 25 MP and was processed at 25 MP. */
  downscaled: boolean;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<AiWorkerRequest<BgRequest>>) => void) | null;
  postMessage(message: AiWorkerResponse<BgResult>, transfer?: Transferable[]): void;
};

// --- the runtime and the model session, kept for the next photo ---

let runtime: { ort: Ort; session: Session } | null = null;
/** Stub builds load the files but never start the runtime: this records that they are in. */
let stubLoaded = false;

/** The model's mask for this input (MODEL_SIZE², 0..1 after normalising). Downloads the files on first use. */
async function predict(input: Float32Array, progress: Progress): Promise<Float32Array> {
  if (!runtime && !stubLoaded) {
    const { wasm, model } = await loadFiles('bg', progress);
    if (import.meta.env.PUBLIC_AI_STUB === '1') {
      const { isStubBadModel } = await import('../stub');
      if (isStubBadModel(model)) throw new AiError('network', { badModel: true });
      stubLoaded = true;
    } else {
      progress('work', 0, 100);
      runtime = await startRuntime(wasm, model);
    }
  }
  progress('work', 20, 100);
  if (import.meta.env.PUBLIC_AI_STUB === '1') {
    const { stubBgMask } = await import('../stub');
    return stubBgMask(MODEL_SIZE);
  }
  const { ort, session } = runtime!;
  const feeds = { [session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, MODEL_SIZE, MODEL_SIZE]) };
  const out = await session.run(feeds);
  const mask = new Float32Array(out[session.outputNames[0]!]!.data as Float32Array);
  for (const t of Object.values(out)) t.dispose();
  return mask;
}

// --- the photo and its 320² mask, kept for compose jobs ---

let kept: { pixels: Pixels; mask: Float32Array; downscaled: boolean } | null = null;

/** The cut-out on `bg`, as a PNG. The mask is brought to full size only for as long as this takes. */
async function encodeCutout(bg: Background): Promise<ArrayBuffer> {
  const { pixels, mask } = kept!;
  const alpha = upsampleMask(mask, MODEL_SIZE, MODEL_SIZE, pixels.width, pixels.height);
  const out = composeRGBA(pixels, alpha, bg);
  return encodePng(out.data, out.width, out.height);
}

async function remove(req: Extract<BgRequest, { op: 'remove' }>, progress: Progress): Promise<BgResult> {
  kept = null; // the last photo's memory goes before this one's arrives
  const { type } = await sniff(new Blob([req.image]));
  if (type === 'unknown') throw new AiError('wrong-type');
  // Decode before any download: a damaged photo fails at once, not after the model arrives.
  const { pixels, downscaled } = prepareInput(await decode(req.image, type));
  const mask = normaliseMask(await predict(toModelInput(pixels), progress));
  kept = { pixels, mask, downscaled };
  progress('work', 70, 100);
  const png = await encodeCutout('transparent');
  progress('work', 90, 100);
  const preview = await encodePreview(pixels);
  progress('work', 100, 100);
  return { png, preview, width: pixels.width, height: pixels.height, downscaled };
}

async function compose(bg: Background): Promise<BgResult> {
  if (!kept) throw new AiError('device'); // this worker was replaced since (it ran out of memory or crashed)
  const { pixels, downscaled } = kept;
  return { png: await encodeCutout(bg), width: pixels.width, height: pixels.height, downscaled };
}

/** The AiError a failure stands for: decode failures are a damaged photo, memory exhaustion is the device. */
function toAiError(err: unknown, op: BgRequest['op']): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof CodecLoadError) return new AiError('network');
  if (isOutOfMemory(err)) return new AiError('device');
  if (err instanceof DecodeError) return new AiError('corrupt');
  console.error('bg worker: unexpected error', err);
  // Re-composing a photo that was already read: what fails there is the PNG build, so memory.
  return new AiError(op === 'compose' ? 'device' : 'corrupt');
}

scope.onmessage = async (e) => {
  const { id, req } = e.data;
  const progress: Progress = (stage, done, total) => scope.postMessage({ kind: 'progress', id, stage, done, total });
  try {
    const result = req.op === 'remove' ? await remove(req, progress) : await compose(req.bg);
    scope.postMessage({ kind: 'done', id, result }, result.preview ? [result.png, result.preview] : [result.png]);
  } catch (raw) {
    const err = toAiError(raw, req.op);
    scope.postMessage({
      kind: 'failed',
      id,
      reason: reasonOf(err),
      ...(err.badModel ? { badModel: true } : {}),
      ...(err.detectedType ? { detectedType: err.detectedType } : {}),
    });
  }
};
