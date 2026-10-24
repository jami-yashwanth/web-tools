/** Where the whisper worker puts the onnxruntime build it chose, for ./ort-shim.ts to hand to transformers.js. */
export const ORT_KEY = Symbol.for('web-tools.whisper.ort');
