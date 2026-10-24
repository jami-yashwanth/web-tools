// Alias (astro.config.mjs) for onnxruntime-web's build that loads its .wasm from bytes or a URL we give it. It has
// the package's own API and types.
declare module 'ort-wasm-runtime' {
  export * from 'onnxruntime-web';
}

// The same, for its WebGPU build (which loads ort-wasm-simd-threaded.asyncify.wasm from bytes we give it).
declare module 'ort-webgpu-runtime' {
  export * from 'onnxruntime-web';
}
