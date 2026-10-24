// Test-only stand-ins used when the site is built with PUBLIC_AI_STUB=1 (the Playwright build). Every import of
// this module sits behind `import.meta.env.PUBLIC_AI_STUB === '1'`, so a production build drops it; the build test
// checks that this marker never reaches dist: __AI_STUB__
// Only inference is stubbed: models still download through the real loader (from routed test bytes), and the
// pixels around the model (decode, orientation, mask upsampling, composing, PNG) are the real code.

export const STUB_MARKER = '__AI_STUB__';

/** The routed test models are filler bytes. All zeros stands for a model that fails to parse ('bad' mode). */
export const isStubBadModel = (model: ArrayBuffer): boolean =>
  new Uint8Array(model, 0, Math.min(16, model.byteLength)).every((b) => b === 0);

/** Remove background: a size × size mask of a centre ellipse (1 inside, 0 outside), as the model would predict. */
export function stubBgMask(size: number): Float32Array {
  const mask = new Float32Array(size * size);
  const c = (size - 1) / 2;
  const rx = size * 0.35;
  const ry = size * 0.42;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) mask[y * size + x] = ((x - c) / rx) ** 2 + ((y - c) / ry) ** 2 <= 1 ? 1 : 0;
  return mask;
}

/**
 * Upscale image: the model's ×`scale` output for a w × h tile (planar RGB), as nearest-neighbour enlargement would
 * give it. Tiling, stitching, halving to 2× and encoding around it are the real code.
 */
export function stubUpscale(input: Float32Array, w: number, h: number, scale: number): Float32Array {
  const ow = w * scale;
  const oh = h * scale;
  const out = new Float32Array(3 * ow * oh);
  for (let c = 0; c < 3; c++)
    for (let y = 0; y < oh; y++)
      for (let x = 0; x < ow; x++) out[c * ow * oh + y * ow + x] = input[c * w * h + Math.floor(y / scale) * w + Math.floor(x / scale)]!;
  return out;
}

/**
 * Transcribe audio: what the model reads in a window that has sound, over the part of it that is its own (from
 * `start` to `end` s). (Windows of silence are not run.) Windowing, timings and the captions are the real code.
 */
export function stubTranscribe(start: number, end: number): { start: number; end: number; text: string } {
  return { start, end, text: 'This is a test transcript.' };
}
