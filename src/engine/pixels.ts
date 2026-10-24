import type { Pixels } from './decode';

/** Apply the EXIF orientation (1-8) to the stored pixels. Returns the input itself when there is nothing to do. */
export function applyOrientation(p: Pixels): Pixels {
  const o = p.orientation;
  if (!(o >= 2 && o <= 8)) return p.orientation === 1 ? p : { ...p, orientation: 1 };
  const { width: sw, height: sh } = p;
  const swap = o >= 5;
  const dw = swap ? sh : sw;
  const dh = swap ? sw : sh;
  const src =
    p.data.byteOffset % 4 === 0
      ? new Uint32Array(p.data.buffer, p.data.byteOffset, sw * sh)
      : new Uint32Array(p.data.slice().buffer);
  const out = new Uint32Array(dw * dh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let dx: number;
      let dy: number;
      switch (o) {
        case 2: dx = sw - 1 - x; dy = y; break;
        case 3: dx = sw - 1 - x; dy = sh - 1 - y; break;
        case 4: dx = x; dy = sh - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = sh - 1 - y; dy = x; break;
        case 7: dx = sh - 1 - y; dy = sw - 1 - x; break;
        default: dx = y; dy = sw - 1 - x; break;
      }
      out[dy * dw + dx] = src[y * sw + x]!;
    }
  }
  return {
    data: new Uint8ClampedArray(out.buffer),
    width: dw,
    height: dh,
    orientation: 1,
    hasAlpha: p.hasAlpha,
  };
}

/** Composite onto white. Works in place (JPG cannot hold alpha, and a 48 MP copy is expensive); the buffer is shared. */
export function flattenOnWhite(p: Pixels): Pixels {
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    if (a !== 255) {
      const inv = 255 - a;
      d[i] = (d[i]! * a + 255 * inv) / 255;
      d[i + 1] = (d[i + 1]! * a + 255 * inv) / 255;
      d[i + 2] = (d[i + 2]! * a + 255 * inv) / 255;
      d[i + 3] = 255;
    }
  }
  return { ...p, hasAlpha: false };
}

/**
 * Shrink to at most `megapixels` million pixels, keeping the aspect ratio. A single area-average (box) pass
 * reads the source once and writes straight into the target buffer, so no intermediate full-size copy exists.
 * Colour is alpha-weighted so transparent pixels do not bleed into their neighbours.
 */
export function downscaleTo(p: Pixels, megapixels: number): Pixels {
  const limit = megapixels * 1e6;
  const { width: sw, height: sh } = p;
  if (sw * sh <= limit) return p;
  const scale = Math.sqrt(limit / (sw * sh));
  return resizeBox(p, Math.max(1, Math.floor(sw * scale)), Math.max(1, Math.floor(sh * scale)));
}

/** Shrink to exactly `dw` × `dh` (each no larger than the source) with the same alpha-weighted box filter. */
export function resizeBox(p: Pixels, dw: number, dh: number): Pixels {
  const { width: sw, height: sh, data: src } = p;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const bx = sw / dw;
  const by = sh / dh;

  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * by;
    const y1 = y0 + by;
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * bx;
      const x1 = x0 + bx;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let y = Math.floor(y0); y < Math.min(sh, Math.ceil(y1)); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        const row = y * sw;
        for (let x = Math.floor(x0); x < Math.min(sw, Math.ceil(x1)); x++) {
          const w = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const i = (row + x) * 4;
          const pa = src[i + 3]! * w;
          r += src[i]! * pa;
          g += src[i + 1]! * pa;
          b += src[i + 2]! * pa;
          a += pa;
          wsum += w;
        }
      }
      const o = (dy * dw + dx) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      }
      out[o + 3] = a / wsum;
    }
  }
  return { data: out, width: dw, height: dh, orientation: p.orientation, hasAlpha: p.hasAlpha };
}
