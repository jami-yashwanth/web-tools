import ORT_WASM_URL from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { WHISPER_BYTES, WHISPER_FILES, WHISPER_GPU_BYTES, WHISPER_GPU_FILES, WHISPER_REPO, WHISPER_REVISION } from './whisper/files';

// Where the AI models are downloaded from. Every model URL is `${MODEL_BASE}/<path>`; this is the one place the
// default is set. For launch the owner points PUBLIC_MODEL_BASE_URL at their own bucket holding the same paths.
const DEFAULT_MODEL_BASE = 'https://huggingface.co';

export const MODEL_BASE: string = (import.meta.env.PUBLIC_MODEL_BASE_URL || DEFAULT_MODEL_BASE).replace(/\/+$/, '');

/**
 * The model host was set for this build (the owner's bucket), so it holds what the default host lacks: the WebGPU
 * runtime (ortWebgpu). Without it, nothing runs on WebGPU.
 */
export const MODEL_BASE_SET: boolean = !!import.meta.env.PUBLIC_MODEL_BASE_URL;

export type ModelKey = 'bg' | 'ortWasm' | 'ortWebgpu' | 'upscale' | 'whisper' | 'whisperGpu' | 'tessdata';

export interface ModelEntry {
  path: string;
  /** The download size in bytes (shown before the first download): for a model of several files, their sum. */
  bytes: number;
  licence: string;
  sameOrigin?: true;
  /** A model of several files: `path` is their directory, and each is downloaded and cached on its own. */
  files?: Record<string, { bytes: number }>;
}

/** Each model's path under MODEL_BASE, its download size in bytes and its licence. Each is checked by the task that ships it. */
export const MODELS: Record<ModelKey, ModelEntry> = {
  // u2netp, U²-Net's small model (Qin et al., Apache-2.0), for everyone: rembg's ONNX export of the authors' weights,
  // byte for byte (md5 8e83ca70e441ab06c318d82300c84806, the checksum rembg pins), as redistributed by
  // BritishWerewolf/U-2-Netp (Apache-2.0), pinned to commit 7112208.
  // sha256 309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8. Verified in Task 5. (Full U²-Net is
  // 176 MB: too large a first download for this tool; ruled out in Task 5.)
  bg: {
    path: 'BritishWerewolf/U-2-Netp/resolve/7112208dbac3a3642496c8d54e2f0f9bb3dc1dc8/onnx/model.onnx',
    bytes: 4_574_861,
    licence: 'Apache-2.0',
  },
  // onnxruntime-web's WebAssembly runtime (MIT), the .wasm Remove background and Upscale image run their models
  // with. It ships with the site (14 MB, under the host's 25 MB file cap) and is downloaded and cached like a model,
  // so its first download is shown and counted with the model's.
  ortWasm: { path: ORT_WASM_URL.replace(/^\/+/, ''), bytes: 14_239_897, licence: 'MIT', sameOrigin: true },
  // The same runtime's WebGPU build (MIT), for Transcribe audio on computers with WebGPU. At 27 MB it is over the
  // host's 25 MB file cap, so it is read from MODEL_BASE at this path (the owner's bucket holds a copy of
  // node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm, version 1.30.0).
  ortWebgpu: { path: 'onnxruntime-web/1.30.0/ort-wasm-simd-threaded.asyncify.wasm', bytes: 26_781_914, licence: 'MIT' },
  // realesr-general-x4v3, Real-ESRGAN's small general model (Xintao Wang et al., BSD-3-Clause), as an fp32 ONNX export
  // of the official weights (realesr-general-x4v3.pth from Real-ESRGAN release v0.2.5.0, sha256 8dc7edb9…6292) by
  // vlad-grig/realesr-general-x4v3-onnx (BSD-3-Clause, the upstream LICENSE in the repo), pinned to commit 0e95d93.
  // sha256 7b10e80021ec3e0ff35017ae5022791879d93a799b2e201e1010a37510202266. Verified in Task 6: its output matches
  // the official weights run in PyTorch to within 6e-6 (on a 0..1 scale).
  upscale: {
    path: 'vlad-grig/realesr-general-x4v3-onnx/resolve/0e95d93e454cf6b5de9bdf5a1c9e7ec340d38231/onnx/model.onnx',
    bytes: 4_866_420,
    licence: 'BSD-3-Clause',
  },
  // Whisper base, its ONNX export (a directory of files, listed in ./whisper/files.ts with their sha256):
  // Xenova/whisper-base (Apache-2.0), pinned to commit 64da572, from openai/whisper-base (Apache-2.0 on Hugging
  // Face; the weights are MIT in openai/whisper). Verified in Task 7. Its 8-bit files for WebAssembly, and its
  // 4-bit/16-bit files for WebGPU (the same directory: the files they share are cached once).
  whisper: {
    path: `${WHISPER_REPO}/resolve/${WHISPER_REVISION}`,
    bytes: WHISPER_BYTES,
    licence: 'Apache-2.0',
    files: WHISPER_FILES,
  },
  whisperGpu: {
    path: `${WHISPER_REPO}/resolve/${WHISPER_REVISION}`,
    bytes: WHISPER_GPU_BYTES,
    licence: 'Apache-2.0',
    files: WHISPER_GPU_FILES,
  },
  // tessdata_fast `eng` 4.1.0, gzipped (its sha256 is on /licenses/). At 2 MB it ships with the site, from
  // public/models/tessdata/ (a .bin name, so no server adds Content-Encoding: gzip and unpacks it in transit), so it is the one model not read from MODEL_BASE. Verified in Task 4.
  tessdata: { path: 'models/tessdata/eng-fast-4.1.0.traineddata.gz.bin', bytes: 1_967_599, licence: 'Apache-2.0', sameOrigin: true },
};

export const modelUrl = (key: ModelKey): string => {
  const { path, sameOrigin } = MODELS[key];
  // Absolute, because Cache Storage keys are. (No location outside a browser: unit tests, where the path stands.)
  return sameOrigin ? `${globalThis.location?.origin ?? ''}/${path}` : `${MODEL_BASE}/${path}`;
};

/** Every file a model downloads, with its URL and size: the model itself, or each file of a directory model. */
export const modelFiles = (key: ModelKey): { url: string; bytes: number }[] => {
  const { files, bytes } = MODELS[key];
  if (!files) return [{ url: modelUrl(key), bytes }];
  return Object.entries(files).map(([name, f]) => ({ url: `${modelUrl(key)}/${name}`, bytes: f.bytes }));
};

/** Models above this size ask before their first download (spec §4). */
export const CONSENT_BYTES = 20_000_000;

/** Whole megabytes, as the AI states show sizes: "45 MB". */
export const megabytes = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`;
