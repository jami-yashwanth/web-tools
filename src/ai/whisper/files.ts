// Whisper base for Transcribe audio: the files transformers.js loads for it, from Xenova/whisper-base (Apache-2.0),
// pinned to one commit. That repo is the ONNX export of openai/whisper-base (Apache-2.0 on Hugging Face; the weights
// are MIT in openai/whisper). Two sets of the encoder and decoder, by how the device runs them:
// - WebAssembly: the 8-bit quantised ("q8") files, the fastest there.
// - WebGPU: the 4-bit weights with 16-bit maths ("q4f16"), about 3× faster than q8 on WebAssembly where the GPU
//   has 16-bit shaders. (q8 on WebGPU was slower than on WebAssembly: measured in Task 7.)
// Kept apart from config.ts (no bundler imports) so the E2E tests can read the sizes. The sha256s are for /licenses/
// only, in their own table so they never reach the page's script.

export const WHISPER_REPO = 'Xenova/whisper-base';
export const WHISPER_REVISION = '64da57285918e20ea79ea5c88eed7197933abaa8';

/** The files both sets share: configuration and tokenizer. */
const SHARED = {
  'config.json': { bytes: 2_248 },
  'generation_config.json': { bytes: 3_776 },
  'preprocessor_config.json': { bytes: 339 },
  'tokenizer.json': { bytes: 2_480_466 },
  'tokenizer_config.json': { bytes: 282_683 },
};

/** For WebAssembly: q8. */
export const WHISPER_FILES: Record<string, { bytes: number }> = {
  ...SHARED,
  'onnx/encoder_model_quantized.onnx': { bytes: 23_200_850 },
  'onnx/decoder_model_merged_quantized.onnx': { bytes: 53_707_539 },
};

/** For WebGPU: q4f16. */
export const WHISPER_GPU_FILES: Record<string, { bytes: number }> = {
  ...SHARED,
  'onnx/encoder_model_q4f16.onnx': { bytes: 14_138_124 },
  'onnx/decoder_model_merged_q4f16.onnx': { bytes: 68_573_265 },
};

export const WHISPER_SHA256: Record<string, string> = {
  'config.json': 'd1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b',
  'generation_config.json': '3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05',
  'preprocessor_config.json': 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
  'tokenizer.json': '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
  'tokenizer_config.json': '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce',
  'onnx/encoder_model_quantized.onnx': '3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9',
  'onnx/decoder_model_merged_quantized.onnx': 'a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861',
  'onnx/encoder_model_q4f16.onnx': '9205a07a3040b786fafc6d8b9afe4339f6acaefb561b51f660ec5327ef4147b8',
  'onnx/decoder_model_merged_q4f16.onnx': 'aadeadbecc79bee3287cb34f0b37c768a0ddfd243c3367f209e446d9e3ae4c4a',
};

const sum = (files: Record<string, { bytes: number }>) => Object.values(files).reduce((n, f) => n + f.bytes, 0);
/** Each set's files together: what the model costs to download. */
export const WHISPER_BYTES = sum(WHISPER_FILES);
export const WHISPER_GPU_BYTES = sum(WHISPER_GPU_FILES);
