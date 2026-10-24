import type { AiWorkerRequest, AiWorkerResponse } from '../client';
import { MODELS, modelFiles, modelUrl, type ModelKey } from '../config';
import { AiError, reasonOf } from '../errors';
import { evictModel, isCached, loadModelFiles } from '../loader';
import type { Progress } from '../ort/runtime';
import { isOutOfMemory, looksLikeOnnx, runtimeMayBeDamaged, sessionFailure } from '../ort/session';
import { SAMPLE_RATE, hasSound } from './audio';
import { ORT_KEY } from './ort-key';
import type { Segment } from './subtitles';
import { collapseRepeats, looksLikeLoop } from './loops';
import { ownSpan, planWindows } from './windows';

// The Transcribe audio worker. A job gets the audio as 16 kHz mono samples (decoded on the page) and transcribes it
// with Whisper base through transformers.js, in 30 s windows that overlap (./windows.ts), merged as its pipeline
// merges them, posting the transcript so far after each window. Windows of silence are not run. The model's files and the onnxruntime .wasm download through our
// loader (Cache Storage, progress); transformers.js reads them from memory, never from the network, and runs on the
// onnxruntime build chosen here (./ort-shim.ts): WebGPU on computers that have it, else WebAssembly. The pipeline is
// kept for the next file. Protocol: ../client.ts.

export interface WhisperRequest {
  /** The audio: Float32 samples, 16 kHz mono. */
  audio: ArrayBuffer;
  /** Run on WebGPU (a computer with WebGPU); else WebAssembly. */
  webgpu: boolean;
}

export interface WhisperResult {
  segments: Segment[];
}

/** Sent with work progress: the transcript so far (its last segment may still change), and whether this is slow. */
export interface WhisperPartial {
  segments: Segment[];
  /** Running on WebAssembly: about as long as the audio. */
  slow: boolean;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<AiWorkerRequest<WhisperRequest>>) => void) | null;
  postMessage(message: AiWorkerResponse<WhisperResult> & { partial?: WhisperPartial }, transfer?: Transferable[]): void;
  location: { href: string };
  crossOriginIsolated?: boolean;
};

/** The id transformers.js knows the model by. Its files come from memory (see `configure`), so it is only a name. */
const MODEL_ID = 'whisper-base';
const STUB = import.meta.env.PUBLIC_AI_STUB === '1';

/** A window's reading, as the pipeline keeps it for merging: its tokens, and [length, left, right] in seconds. */
interface Reading {
  tokens: (number | bigint)[];
  stride: [number, number, number];
}

/** The parts of transformers.js's speech recognition pipeline used here (version pinned in package.json). */
interface Transcriber {
  processor: {
    (audio: Float32Array): Promise<{ input_features: unknown }>;
    feature_extractor: { config: { chunk_length: number } };
  };
  tokenizer: {
    decode(tokens: number[], options: { skip_special_tokens: true }): string;
    timestamp_begin: number;
    all_special_ids: number[];
    /** The pipeline's own merge of overlapping windows into timed segments. */
    _decode_asr(
      readings: Reading[],
      options: { time_precision: number; return_timestamps: true; force_full_sequences: false },
    ): [string, { chunks?: { timestamp: [number, number | null]; text: string }[] }];
  };
  model: {
    (inputs: Record<string, unknown>): Promise<{ logits: { data: Float32Array; dims: number[] } }>;
    generate(options: Record<string, unknown>): Promise<{ [row: number]: { tolist(): (number | bigint)[] } }>;
    config: { max_source_positions: number };
    generation_config: { decoder_start_token_id: number; is_multilingual?: boolean; lang_to_id?: Record<string, number> };
  };
}
type Transformers = typeof import('@huggingface/transformers');

let pipe: { run: Transcriber; tf: Transformers; slow: boolean } | null = null;
/** Stub builds load the files but never start the model: this records that they are in. */
let stubLoaded: { slow: boolean } | null = null;

/** How a run goes: which set of model files, on which runtime. */
interface Plan {
  model: Extract<ModelKey, 'whisper' | 'whisperGpu'>;
  webgpu: boolean;
}
const runtimeKey = (webgpu: boolean): ModelKey => (webgpu ? 'ortWebgpu' : 'ortWasm');
/** The files each set is quantised to, as transformers.js names it. */
const DTYPE = { whisper: 'q8', whisperGpu: 'q4f16' } as const;

/** Download (first use) the model's files and the runtime, through our loader. */
async function loadAll(plan: Plan, progress: Progress): Promise<{ files: Map<string, ArrayBuffer>; plan: Plan }> {
  const report = (done: number, total: number) => progress('download', done, total);
  try {
    return { files: await loadModelFiles([plan.model, runtimeKey(plan.webgpu)], report), plan };
  } catch (err) {
    // The model came in but the WebGPU runtime did not (a model host without it): run on WebAssembly instead.
    if (!plan.webgpu || reasonOf(err) !== 'network') throw err;
    const modelIn = await Promise.all(modelFiles(plan.model).map((f) => isCached(f.url)));
    if (!modelIn.every(Boolean)) throw err;
    return { files: await loadModelFiles([plan.model, 'ortWasm'], report), plan: { ...plan, webgpu: false } };
  }
}

/** Download (first use) and start the model. Says whether it runs on WebAssembly (slow). */
async function ready(webgpu: boolean, progress: Progress): Promise<{ slow: boolean }> {
  if (pipe) return pipe;
  if (stubLoaded) return stubLoaded;
  const { files, plan } = await loadAll({ model: webgpu ? 'whisperGpu' : 'whisper', webgpu }, progress);
  const byName = modelFilesByName(files, plan.model); // parse checks first: damaged files are a bad model
  if (STUB) {
    const { isStubBadModel } = await import('../stub');
    if ([...byName].some(([name, bytes]) => name.endsWith('.onnx') && isStubBadModel(bytes))) {
      throw new AiError('network', { badModel: true });
    }
    return (stubLoaded = { slow: !plan.webgpu });
  }
  progress('work', 0, 100);
  pipe = await startPipeline(byName, files.get(modelUrl(runtimeKey(plan.webgpu)))!, plan);
  return pipe;
}

/** Each model file by its name ("config.json", "onnx/…"), checked: JSON that parses, ONNX that looks like ONNX. */
function modelFilesByName(files: Map<string, ArrayBuffer>, model: Plan['model']): Map<string, ArrayBuffer> {
  const byName = new Map<string, ArrayBuffer>();
  for (const name of Object.keys(MODELS[model].files!)) {
    const bytes = files.get(`${modelUrl(model)}/${name}`)!;
    // The stub's routed files are filler bytes: only its own check applies (above).
    const ok = STUB || (name.endsWith('.onnx') ? looksLikeOnnx(bytes) : parses(bytes));
    if (!ok) throw new AiError('network', { badModel: true });
    byName.set(name, bytes);
  }
  return byName;
}
function parses(bytes: ArrayBuffer): boolean {
  try {
    JSON.parse(new TextDecoder().decode(bytes));
    return true;
  } catch {
    return false;
  }
}

/** Start onnxruntime (its script ships with the site; the .wasm came through our loader), then the pipeline on it. */
async function startPipeline(
  byName: Map<string, ArrayBuffer>,
  wasm: ArrayBuffer,
  { model, webgpu }: Plan,
): Promise<{ run: Transcriber; tf: Transformers; slow: boolean }> {
  let ort: typeof import('onnxruntime-web');
  let glue: string;
  let tf: Transformers;
  try {
    const [mod, mjs] = await Promise.all(
      webgpu
        ? [import('ort-webgpu-runtime'), import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url')]
        : [import('ort-wasm-runtime'), import('onnxruntime-web/ort-wasm-simd-threaded.mjs?url')],
    );
    ort = mod;
    glue = new URL(mjs.default, scope.location.href).href;
    await import(/* @vite-ignore */ glue); // a glue script that can't load is a network failure, not the device's
    ort.env.logLevel = 'error';
    ort.env.wasm.proxy = false; // already off the main thread
    ort.env.wasm.numThreads = scope.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    ort.env.wasm.wasmPaths = { mjs: glue };
    ort.env.wasm.wasmBinary = wasm;
    (globalThis as unknown as Record<symbol, unknown>)[ORT_KEY] = ort;
    tf = await import('@huggingface/transformers');
  } catch {
    throw new AiError('network');
  }
  configure(tf, byName);

  const create = (device: 'webgpu' | 'wasm') =>
    tf.pipeline('automatic-speech-recognition', MODEL_ID, { device, dtype: DTYPE[model] }) as unknown as Promise<Transcriber>;
  try {
    return { run: await create(webgpu ? 'webgpu' : 'wasm'), tf, slow: !webgpu };
  } catch (err) {
    const failure = sessionFailure(err);
    if (webgpu && !failure.badModel) {
      // WebGPU would not start here: the same runtime also runs on the CPU.
      try {
        return { run: await create('wasm'), tf, slow: true };
      } catch (again) {
        throw await dropRuntime(sessionFailure(again), webgpu);
      }
    }
    throw await dropRuntime(failure, webgpu);
  }
}

/**
 * A runtime that won't start may be a damaged cached .wasm: drop it, so the next try downloads it afresh (not when
 * memory ran out: see runtimeMayBeDamaged).
 */
async function dropRuntime(err: AiError, webgpu: boolean): Promise<AiError> {
  if (runtimeMayBeDamaged(err)) await evictModel(modelUrl(runtimeKey(webgpu)));
  return err;
}

/** transformers.js reads the model's files from memory only: no network, no cache of its own. */
function configure(tf: Transformers, byName: Map<string, ArrayBuffer>): void {
  const { env } = tf;
  env.allowRemoteModels = false;
  env.allowLocalModels = true; // "local" here is the fetch below
  env.localModelPath = '/';
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.useCustomCache = false;
  env.useWasmCache = false;
  env.fetch = async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const name = [...byName.keys()].find((n) => url.endsWith(`/${n}`));
    const bytes = name && byName.get(name);
    if (!bytes) return new Response(null, { status: 404 }); // a file this model doesn't have
    return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } });
  };
}

/** Whisper's guess at the language, from the first window with sound ("fr"), or undefined to leave it to the default. */
async function detectLanguage({ run, tf }: { run: Transcriber; tf: Transformers }, audio: Float32Array): Promise<string | undefined> {
  const config = run.model.generation_config;
  if (!config.is_multilingual || !config.lang_to_id) return undefined;
  try {
    const { input_features } = await run.processor(audio);
    const start = new tf.Tensor('int64', BigInt64Array.from([BigInt(config.decoder_start_token_id)]), [1, 1]);
    const { logits } = await run.model({ input_features, decoder_input_ids: start });
    const vocab = logits.dims.at(-1)!;
    const last = logits.data.subarray(logits.data.length - vocab);
    let best: string | undefined;
    let bestScore = -Infinity;
    for (const [token, id] of Object.entries(config.lang_to_id)) {
      if (last[id]! > bestScore) {
        bestScore = last[id]!;
        best = token;
      }
    }
    return best?.replace(/^<\|(.+)\|>$/, '$1');
  } catch (err) {
    console.warn('whisper worker: language detection failed, using the default', err);
    return undefined;
  }
}

/** Progress, with the work done so far for the page to show. */
type Report = (stage: 'download' | 'work', done: number, total: number, partial?: WhisperPartial) => void;

async function transcribe(req: WhisperRequest, report: Report): Promise<WhisperResult> {
  const audio = new Float32Array(req.audio);
  const { slow } = await ready(req.webgpu, report);
  const windows = planWindows(audio.length, SAMPLE_RATE);
  let segments: Segment[] = [];
  report('work', 0, windows.length, { segments, slow });

  const readings: Reading[] = [];
  let language: string | undefined;
  let detected = false;
  for (const [i, w] of windows.entries()) {
    const samples = audio.subarray(w.start, w.end);
    const sound = hasSound(samples, SAMPLE_RATE);
    if (STUB) {
      const { stubTranscribe } = await import('../stub');
      await new Promise((r) => setTimeout(r, 50)); // a model takes time: long files stay cancellable in tests
      if (sound) segments = [...segments, stubTranscribe(...ownSpan(w, SAMPLE_RATE))];
    } else {
      const { run } = pipe!;
      if (sound && !detected) {
        language = await detectLanguage(pipe!, samples);
        detected = true;
      }
      // A window of silence has nothing to read: no tokens (the model would only make up words for it).
      let tokens = sound ? await readWindow(run, samples, language) : [];
      if (isLoop(run, tokens)) tokens = []; // a loop: better no words than made-up ones
      readings.push({ tokens, stride: [w.end - w.start, w.strideLeft, w.strideRight].map((n) => n / SAMPLE_RATE) as Reading['stride'] });
      segments = merge(run, readings, w.end / SAMPLE_RATE);
    }
    report('work', i + 1, windows.length, { segments, slow });
  }
  return { segments };
}

/** One window's tokens, read as the pipeline reads them (with timestamps, in the detected language). */
async function readWindow(run: Transcriber, samples: Float32Array, language: string | undefined): Promise<(number | bigint)[]> {
  const { input_features } = await run.processor(samples);
  const out = await run.model.generate({
    inputs: input_features,
    return_timestamps: true,
    task: 'transcribe',
    ...(language ? { language } : {}),
  });
  return out[0]!.tolist();
}

/** Did the model fall into a loop on this window? (Its words alone: no timestamps, no special tokens.) */
function isLoop(run: Transcriber, tokens: (number | bigint)[]): boolean {
  const special = new Set(run.tokenizer.all_special_ids);
  const words = tokens.map(Number).filter((t) => t < run.tokenizer.timestamp_begin && !special.has(t));
  const loop = looksLikeLoop(run.tokenizer.decode(words, { skip_special_tokens: true }), words);
  if (loop) console.warn('whisper worker: dropped a window that repeats itself');
  return loop;
}

/** The readings so far merged into timed segments, as the pipeline does; a segment not yet ended ends at `until`. */
function merge(run: Transcriber, readings: Reading[], until: number): Segment[] {
  const time_precision = run.processor.feature_extractor.config.chunk_length / run.model.config.max_source_positions;
  const [, { chunks = [] }] = run.tokenizer._decode_asr(readings, { time_precision, return_timestamps: true, force_full_sequences: false });
  return collapseRepeats(
    chunks.map((c) => ({ start: c.timestamp[0], end: c.timestamp[1] ?? until, text: c.text.trim() })).filter((c) => c.text),
  );
}

function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (isOutOfMemory(err)) return new AiError('device');
  console.error('whisper worker: unexpected error', err);
  return new AiError('corrupt');
}

scope.onmessage = async (e) => {
  const { id, req } = e.data;
  const report: Report = (stage, done, total, partial) =>
    scope.postMessage({ kind: 'progress', id, stage, done, total, ...(partial ? { partial } : {}) });
  try {
    scope.postMessage({ kind: 'done', id, result: await transcribe(req, report) });
  } catch (raw) {
    const err = toAiError(raw);
    scope.postMessage({
      kind: 'failed',
      id,
      reason: reasonOf(err),
      ...(err.badModel ? { badModel: true } : {}),
    });
  }
};
