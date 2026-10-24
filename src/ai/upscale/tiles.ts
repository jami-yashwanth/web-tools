import type { Pixels } from '../../engine/decode';
import { resizeBox } from '../../engine/pixels';

// Upscale image, the pixel work around the model: cut the image into overlapping tiles the model can take, turn
// each tile's model output into RGBA at the chosen scale, and feather the tiles together into one image. Pure
// functions, run in the upscale worker and in unit tests.

/** Tiles are TILE × TILE source pixels, overlapping their neighbours by OVERLAP (spec §3). */
export const TILE = 128;
export const OVERLAP = 16;
/** realesr-general-x4v3 always enlarges ×4; a 2× result is its output halved. */
export const MODEL_SCALE = 4;
/** The upscaled image is capped at 16 MP (spec §3). */
export const MAX_OUTPUT_PIXELS = 16_000_000;

export type Scale = 2 | 4;

/** A rectangle of the source image, in source pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Will the image, enlarged `scale` times, stay within the cap? */
export const fitsOutput = (w: number, h: number, scale: Scale): boolean => w * scale * h * scale <= MAX_OUTPUT_PIXELS;

/** Tile starts along one edge: every `tile − overlap`, the last one moved back to end at the edge. */
function starts(size: number, tile: number, overlap: number): number[] {
  const out = [0];
  while (out.at(-1)! + tile < size) out.push(Math.min(out.at(-1)! + tile - overlap, size - tile));
  return out;
}

/**
 * The tiles covering a w × h image, row by row, left to right (so a tile's left and upper neighbours come before
 * it). Each is `tile` square, or the whole width or height when the image is smaller. Neighbours overlap by at
 * least `overlap`.
 */
export function planTiles(w: number, h: number, tile = TILE, overlap = OVERLAP): Rect[] {
  const tw = Math.min(tile, w);
  const th = Math.min(tile, h);
  const tiles: Rect[] = [];
  for (const y of starts(h, tile, overlap)) for (const x of starts(w, tile, overlap)) tiles.push({ x, y, w: tw, h: th });
  return tiles;
}

/**
 * The upscaled image, built one tile at a time in one buffer (no tile is kept once added). Tiles must arrive in
 * planTiles order. Where a tile overlaps the image so far, it fades in over the first `overlap` source pixels from
 * its left and top edges, so the model's edge effects never show and no seam does either. Where tiles agree, the
 * result is exactly their pixels.
 */
export class Stitcher {
  readonly data: Uint8ClampedArray;
  private readonly outW: number;

  constructor(
    w: number,
    h: number,
    private readonly scale: number,
    private readonly overlap: number,
  ) {
    this.outW = w * scale;
    this.data = new Uint8ClampedArray(this.outW * h * scale * 4);
  }

  /** Add a tile: `tile` is `rect` enlarged `scale` times, as RGBA. */
  add(rect: Rect, tile: Uint8ClampedArray): void {
    const s = this.scale;
    const tw = rect.w * s;
    const th = rect.h * s;
    const ramp = this.overlap * s;
    const fadeX = rect.x > 0;
    const fadeY = rect.y > 0;
    const out = this.data;
    for (let ty = 0; ty < th; ty++) {
      const ry = fadeY && ty < ramp ? (ty + 0.5) / ramp : 1;
      const src = ty * tw * 4;
      const dst = ((rect.y * s + ty) * this.outW + rect.x * s) * 4;
      if (ry === 1 && !fadeX) {
        out.set(tile.subarray(src, src + tw * 4), dst);
        continue;
      }
      for (let tx = 0; tx < tw; tx++) {
        const r = ry * (fadeX && tx < ramp ? (tx + 0.5) / ramp : 1);
        const i = src + tx * 4;
        const o = dst + tx * 4;
        if (r === 1) {
          out[o] = tile[i]!;
          out[o + 1] = tile[i + 1]!;
          out[o + 2] = tile[i + 2]!;
          out[o + 3] = tile[i + 3]!;
        } else {
          out[o] = out[o]! + (tile[i]! - out[o]!) * r;
          out[o + 1] = out[o + 1]! + (tile[i + 1]! - out[o + 1]!) * r;
          out[o + 2] = out[o + 2]! + (tile[i + 2]! - out[o + 2]!) * r;
          out[o + 3] = out[o + 3]! + (tile[i + 3]! - out[o + 3]!) * r;
        }
      }
    }
  }
}

/** All tiles at once (planTiles order): the w × h image enlarged `scale` times, as RGBA. */
export function stitch(tiles: { rect: Rect; data: Uint8ClampedArray }[], w: number, h: number, scale: Scale, overlap: number): Uint8ClampedArray {
  const s = new Stitcher(w, h, scale, overlap);
  for (const t of tiles) s.add(t.rect, t.data);
  return s.data;
}

/** The model's input for a tile: its pixels as planar RGB (1 × 3 × h × w) in 0..1. Alpha is left out. */
export function tileInput(p: Pixels, r: Rect): Float32Array {
  const plane = r.w * r.h;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < r.h; y++) {
    let i = ((r.y + y) * p.width + r.x) * 4;
    for (let x = 0, o = y * r.w; x < r.w; x++, o++, i += 4) {
      out[o] = p.data[i]! / 255;
      out[plane + o] = p.data[i + 1]! / 255;
      out[2 * plane + o] = p.data[i + 2]! / 255;
    }
  }
  return out;
}

/**
 * A tile's result as RGBA at `scale`, from the model's ×4 output (planar RGB, nominally 0..1; clamped). The model
 * has no alpha: a transparent image's alpha is enlarged from the whole image (bilinear, so neighbouring tiles
 * agree). At 2× the ×4 result is halved with the box filter.
 */
export function tileToRgba(model: Float32Array, src: Pixels, r: Rect, scale: Scale): Uint8ClampedArray {
  const w4 = r.w * MODEL_SCALE;
  const h4 = r.h * MODEL_SCALE;
  const plane = w4 * h4;
  const out = new Uint8ClampedArray(plane * 4);
  for (let i = 0; i < plane; i++) {
    out[i * 4] = model[i]! * 255;
    out[i * 4 + 1] = model[plane + i]! * 255;
    out[i * 4 + 2] = model[2 * plane + i]! * 255;
    out[i * 4 + 3] = 255;
  }
  if (src.hasAlpha) enlargeAlpha(src, r, out);
  if (scale === MODEL_SCALE) return out;
  const four: Pixels = { data: out, width: w4, height: h4, orientation: 1, hasAlpha: src.hasAlpha };
  return resizeBox(four, r.w * scale, r.h * scale).data;
}

/** Fill `out`'s alpha (the tile at ×4) from the source's, bilinear, pixel centres aligned, edges clamped. */
function enlargeAlpha(src: Pixels, r: Rect, out: Uint8ClampedArray): void {
  const { width: sw, height: sh, data } = src;
  const w4 = r.w * MODEL_SCALE;
  const h4 = r.h * MODEL_SCALE;
  const at = (x: number, y: number) => data[(y * sw + x) * 4 + 3]!;
  for (let ty = 0; ty < h4; ty++) {
    const fy = Math.min(sh - 1, Math.max(0, (r.y * MODEL_SCALE + ty + 0.5) / MODEL_SCALE - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let tx = 0; tx < w4; tx++) {
      const fx = Math.min(sw - 1, Math.max(0, (r.x * MODEL_SCALE + tx + 0.5) / MODEL_SCALE - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * wx;
      const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * wx;
      out[(ty * w4 + tx) * 4 + 3] = top + (bottom - top) * wy;
    }
  }
}
