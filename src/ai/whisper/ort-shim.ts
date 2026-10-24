// transformers.js imports onnxruntime as 'onnxruntime-web/webgpu'. That name is aliased to this module
// (astro.config.mjs), so it runs on the onnxruntime-web build the whisper worker chose for this device (the WebGPU
// build, or the WebAssembly build the other tools use) and set at ORT_KEY before importing transformers.js. The
// package's own build would bring a second runtime, fetch its .wasm from a CDN, and put a 27 MB .wasm into dist.

import { ORT_KEY } from './ort-key';

type Ort = typeof import('onnxruntime-web');
const ort = (globalThis as unknown as Record<symbol, Ort | undefined>)[ORT_KEY];
if (!ort) throw new Error('whisper: set the runtime at ORT_KEY before importing transformers.js');

// All that transformers.js reads from it.
export const InferenceSession = ort.InferenceSession;
export const Tensor = ort.Tensor;
export const env = ort.env;
