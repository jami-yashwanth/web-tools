import { load } from '../engine/codecs';
import type { Pixels } from '../engine/decode';
import { downscaleTo, flattenOnWhite } from '../engine/pixels';

// Encoding an AI tool's result in its worker (Remove background, Upscale image): the PNG to download, and the small
// "before" image of the before/after comparison.

/** Smallest zlib effort: a 25 MP image encodes in seconds, not minutes. The pixels are lossless either way. */
const PNG_LEVEL = 1;
const PREVIEW_EDGE = 2048;
const PREVIEW_QUALITY = 85;

/** The bytes as an ArrayBuffer of their own (one that can be transferred), copying only when they are a view. */
const own = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);

/** RGBA pixels as a PNG. */
export async function encodePng(data: Uint8ClampedArray, width: number, height: number): Promise<ArrayBuffer> {
  return own((await load.oxipng()).optimise_raw(data, width, height, PNG_LEVEL, false, false));
}

/** The "before" image: the upright image, at most PREVIEW_EDGE on its long edge, flattened onto white, as a JPEG. */
export async function encodePreview(p: Pixels): Promise<ArrayBuffer> {
  const long = Math.max(p.width, p.height);
  const small = long > PREVIEW_EDGE ? downscaleTo(p, (p.width * p.height * (PREVIEW_EDGE / long) ** 2) / 1e6) : p;
  // flattenOnWhite works in place: never on the caller's pixels.
  const flat = p.hasAlpha ? flattenOnWhite(small === p ? { ...p, data: p.data.slice() } : small) : small;
  const image = { data: flat.data, width: flat.width, height: flat.height };
  return own((await load.jpegEnc()).encode(image, PREVIEW_QUALITY));
}
