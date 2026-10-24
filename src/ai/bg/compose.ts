import type { Pixels } from '../../engine/decode';
import { applyOrientation, downscaleTo } from '../../engine/pixels';

// Remove background, the pixel work around the model: turn the photo upright and cap its size, make the model's
// input, and turn the model's mask into the result. Pure functions, run in the bg worker and in unit tests.

/** The model's input is MODEL_SIZE × MODEL_SIZE (u2netp). */
export const MODEL_SIZE = 320;
/** Photos above this are downscaled to it first (spec §3), with a note. */
export const MAX_MEGAPIXELS = 25;

// The ImageNet statistics U²-Net was trained with.
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

export type Background = 'transparent' | { r: number; g: number; b: number };

/** The photo as the model and the result see it: upright (EXIF orientation applied) and at most 25 MP. */
export function prepareInput(raw: Pixels): { pixels: Pixels; downscaled: boolean } {
  const upright = applyOrientation(raw);
  const pixels = downscaleTo(upright, MAX_MEGAPIXELS);
  return { pixels, downscaled: pixels !== upright };
}

/**
 * The model's input: the photo stretched to MODEL_SIZE² (each target pixel the mean of the source pixels it
 * covers), as planar RGB (1×3×H×W) normalised with the ImageNet mean and std. Alpha is ignored.
 */
export function toModelInput(p: Pixels, size = MODEL_SIZE): Float32Array {
  const { width: sw, height: sh, data } = p;
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  const bx = sw / size;
  const by = sh / size;
  for (let dy = 0; dy < size; dy++) {
    const y0 = dy * by;
    const y1 = y0 + by;
    const yStart = Math.floor(y0);
    const yEnd = Math.min(sh, Math.ceil(y1));
    for (let dx = 0; dx < size; dx++) {
      const x0 = dx * bx;
      const x1 = x0 + bx;
      const xStart = Math.floor(x0);
      const xEnd = Math.min(sw, Math.ceil(x1));
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let y = yStart; y < yEnd; y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = xStart; x < xEnd; x++) {
          const w = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const i = (y * sw + x) * 4;
          r += data[i]! * w;
          g += data[i + 1]! * w;
          b += data[i + 2]! * w;
          wsum += w;
        }
      }
      const o = dy * size + dx;
      const k = 255 * (wsum || 1);
      out[o] = (r / k - MEAN[0]) / STD[0];
      out[plane + o] = (g / k - MEAN[1]) / STD[1];
      out[2 * plane + o] = (b / k - MEAN[2]) / STD[2];
    }
  }
  return out;
}

/** Stretch the model's prediction to fill 0..1 (in place), as U²-Net's own inference does. A flat one is left alone. */
export function normaliseMask(mask: Float32Array): Float32Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of mask) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo;
  if (!(range > 0)) return mask;
  for (let i = 0; i < mask.length; i++) mask[i] = (mask[i]! - lo) / range;
  return mask;
}

/**
 * The mask (mw × mh, values 0..1) resized to w × h with bilinear filtering, as alpha 0..255. Pixel centres line up
 * (no corner alignment), and samples past the edge take the edge value.
 */
export function upsampleMask(mask: Float32Array, mw: number, mh: number, w: number, h: number): Uint8ClampedArray {
  const clamped = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) clamped[i] = Math.min(1, Math.max(0, mask[i]!));
  // Per column: the two source columns and the weight of the right one (computed once, used on every row).
  const x0s = new Int32Array(w);
  const x1s = new Int32Array(w);
  const fxs = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const sx = Math.min(mw - 1, Math.max(0, ((x + 0.5) * mw) / w - 0.5));
    x0s[x] = Math.floor(sx);
    x1s[x] = Math.min(mw - 1, x0s[x]! + 1);
    fxs[x] = sx - x0s[x]!;
  }
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mh - 1, Math.max(0, ((y + 0.5) * mh) / h - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(mh - 1, y0 + 1);
    const fy = sy - y0;
    const r0 = y0 * mw;
    const r1 = y1 * mw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const a = x0s[x]!;
      const b = x1s[x]!;
      const fx = fxs[x]!;
      const top = clamped[r0 + a]! + (clamped[r0 + b]! - clamped[r0 + a]!) * fx;
      const bottom = clamped[r1 + a]! + (clamped[r1 + b]! - clamped[r1 + a]!) * fx;
      out[row + x] = (top + (bottom - top) * fy) * 255;
    }
  }
  return out;
}

/**
 * The cut-out: the photo with `alpha` (one byte per pixel) as its transparency, combined with any transparency the
 * photo already had. On a colour, it is blended onto that colour and opaque. Returns new pixels; `px` is unchanged.
 */
export function composeRGBA(px: Pixels, alpha: Uint8ClampedArray, bg: Background): Pixels {
  const src = px.data;
  const out = new Uint8ClampedArray(src.length);
  if (bg === 'transparent') {
    for (let i = 0, j = 0; j < alpha.length; i += 4, j++) {
      out[i] = src[i]!;
      out[i + 1] = src[i + 1]!;
      out[i + 2] = src[i + 2]!;
      out[i + 3] = (src[i + 3]! * alpha[j]!) / 255;
    }
    return { data: out, width: px.width, height: px.height, orientation: px.orientation, hasAlpha: true };
  }
  const { r, g, b } = bg;
  for (let i = 0, j = 0; j < alpha.length; i += 4, j++) {
    const a = (src[i + 3]! * alpha[j]!) / 255;
    const inv = 255 - a;
    out[i] = (src[i]! * a + r * inv) / 255;
    out[i + 1] = (src[i + 1]! * a + g * inv) / 255;
    out[i + 2] = (src[i + 2]! * a + b * inv) / 255;
    out[i + 3] = 255;
  }
  return { data: out, width: px.width, height: px.height, orientation: px.orientation, hasAlpha: false };
}
