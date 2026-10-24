import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT_PIXELS, Stitcher, fitsOutput, planTiles, stitch, tileInput, tileToRgba, type Rect } from '../../src/ai/upscale/tiles';
import type { Pixels } from '../../src/engine/decode';

const TILE = 128;
const OVERLAP = 16;

/** A w × h RGBA image of seeded noise (opaque unless `alpha`). */
function noise(w: number, h: number, alpha = false, seed = 1): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    data[i] = (i & 3) === 3 && !alpha ? 255 : s >>> 24;
  }
  return { data, width: w, height: h, orientation: 1, hasAlpha: alpha };
}

/** Nearest-neighbour × `s` of a rectangle of `p`, as RGBA. */
function nearest(p: Pixels, r: Rect, s: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * s * r.h * s * 4);
  for (let y = 0; y < r.h * s; y++)
    for (let x = 0; x < r.w * s; x++) {
      const i = ((r.y + Math.floor(y / s)) * p.width + r.x + Math.floor(x / s)) * 4;
      out.set(p.data.subarray(i, i + 4), (y * r.w * s + x) * 4);
    }
  return out;
}

const maxDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
};

describe('planTiles', () => {
  const sizes: [number, number][] = [[1, 1], [50, 30], [128, 128], [129, 128], [240, 240], [241, 500], [1600, 1200], [300, 400]];

  it.each(sizes)('%i × %i: tiles cover every pixel and stay inside the image', (w, h) => {
    const tiles = planTiles(w, h, TILE, OVERLAP);
    const covered = new Uint8Array(w * h);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(w);
      expect(t.y + t.h).toBeLessThanOrEqual(h);
      expect(t.w).toBe(Math.min(TILE, w));
      expect(t.h).toBe(Math.min(TILE, h));
      for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) covered[y * w + x] = 1;
    }
    expect(covered.every((c) => c === 1)).toBe(true);
  });

  it('neighbouring tiles overlap by at least the overlap, in rows, left to right', () => {
    const tiles = planTiles(1000, 700, TILE, OVERLAP);
    const xs = [...new Set(tiles.map((t) => t.x))];
    const ys = [...new Set(tiles.map((t) => t.y))];
    expect(tiles.length).toBe(xs.length * ys.length);
    for (let i = 1; i < xs.length; i++) expect(xs[i - 1]! + TILE - xs[i]!).toBeGreaterThanOrEqual(OVERLAP);
    for (let i = 1; i < ys.length; i++) expect(ys[i - 1]! + TILE - ys[i]!).toBeGreaterThanOrEqual(OVERLAP);
    // Raster order: a tile's left and upper neighbours come before it (the stitcher relies on that).
    for (let i = 1; i < tiles.length; i++) {
      const [a, b] = [tiles[i - 1]!, tiles[i]!];
      expect(b.y > a.y || (b.y === a.y && b.x > a.x)).toBe(true);
    }
    // No more tiles than needed: the step is tile − overlap.
    expect(xs.length).toBe(Math.ceil((1000 - OVERLAP) / (TILE - OVERLAP)));
  });
});

describe('stitch', () => {
  it.each([[300, 200], [129, 400], [64, 64]])(
    'nearest ×2 per tile, stitched, equals nearest ×2 of the whole %i × %i image (no seams)',
    (w, h) => {
      const p = noise(w, h, true);
      const tiles = planTiles(w, h, TILE, OVERLAP).map((rect) => ({ rect, data: nearest(p, rect, 2) }));
      const out = stitch(tiles, w, h, 2, OVERLAP);
      expect(out.length).toBe(w * 2 * h * 2 * 4);
      expect(maxDiff(out, nearest(p, { x: 0, y: 0, w, h }, 2))).toBeLessThanOrEqual(1);
    },
  );

  it('feathers across the overlap: two flat tiles meet in a smooth ramp, not a step', () => {
    const w = 240; // two tiles across: x 0..127 and 112..239
    const h = 8;
    const tiles = planTiles(w, h, TILE, OVERLAP);
    expect(tiles.map((t) => t.x)).toEqual([0, 112]);
    const flat = (r: Rect, v: number) => new Uint8ClampedArray(r.w * 4 * r.h * 4 * 4).fill(v);
    const out = stitch(tiles.map((rect, i) => ({ rect, data: flat(rect, i === 0 ? 0 : 255) })), w, h, 4, OVERLAP);
    const row = Array.from({ length: w * 4 }, (_, x) => out[(2 * w * 4 + x) * 4]!);
    expect(row[0]).toBe(0);
    expect(row[w * 4 - 1]).toBe(255);
    for (let x = 1; x < row.length; x++) {
      expect(row[x]!).toBeGreaterThanOrEqual(row[x - 1]!); // monotonic
      expect(row[x]! - row[x - 1]!).toBeLessThanOrEqual(8); // no step: 255 spread over 16 × 4 output pixels
    }
  });

  it('the Stitcher takes tiles one at a time into one buffer (what stitch does at once)', () => {
    const p = noise(200, 150);
    const plan = planTiles(200, 150, TILE, OVERLAP);
    const s = new Stitcher(200, 150, 4, OVERLAP);
    for (const rect of plan) s.add(rect, nearest(p, rect, 4));
    expect(s.data.length).toBe(800 * 600 * 4);
    expect(maxDiff(s.data, nearest(p, { x: 0, y: 0, w: 200, h: 150 }, 4))).toBeLessThanOrEqual(1);
  });
});

describe('tiles and the model', () => {
  it('tileInput: the rectangle as planar RGB in 0..1', () => {
    const p = noise(10, 6);
    const r = { x: 2, y: 1, w: 3, h: 2 };
    const t = tileInput(p, r);
    expect(t.length).toBe(3 * 6);
    const at = (x: number, y: number, c: number) => p.data[((r.y + y) * 10 + r.x + x) * 4 + c]! / 255;
    expect(t[0]).toBeCloseTo(at(0, 0, 0));
    expect(t[6 + 4]).toBeCloseTo(at(1, 1, 1));
    expect(t[12 + 5]).toBeCloseTo(at(2, 1, 2));
  });

  /** The model's ×4 output for a tile, as an identity (nearest ×4) would give it: planar RGB in 0..1. */
  const identity4 = (p: Pixels, r: Rect) => {
    const rgba = nearest(p, r, 4);
    const n = r.w * 4 * r.h * 4;
    const out = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[c * n + i] = rgba[i * 4 + c]! / 255;
    return out;
  };

  it('tileToRgba ×4: the model output as RGBA bytes, opaque for an opaque image, clamped to 0..255', () => {
    const p = noise(20, 10);
    const r = { x: 4, y: 2, w: 8, h: 6 };
    const model = identity4(p, r);
    model[0] = 1.2; // a value the model put slightly out of range
    model[1] = -0.1;
    const out = tileToRgba(model, p, r, 4);
    const want = nearest(p, r, 4);
    want[0] = 255;
    want[4] = 0;
    expect(out.length).toBe(want.length);
    expect(maxDiff(out, want)).toBeLessThanOrEqual(1);
  });

  it('tileToRgba ×2: the ×4 output halved by the box filter (2 × 2 averages)', () => {
    const p = noise(16, 16);
    const r = { x: 0, y: 0, w: 16, h: 16 };
    const out = tileToRgba(identity4(p, r), p, r, 2);
    // Nearest ×4, halved: each 2 × 2 block is one source pixel, so the result is nearest ×2.
    expect(maxDiff(out, nearest(p, r, 2))).toBeLessThanOrEqual(1);
  });

  it('tileToRgba keeps transparency: alpha is enlarged from the image (smoothly), colour from the model', () => {
    const p = noise(8, 8, true);
    for (let i = 3; i < p.data.length; i += 4) p.data[i] = i < p.data.length / 2 ? 0 : 255; // top half clear
    const r = { x: 0, y: 0, w: 8, h: 8 };
    const out = tileToRgba(identity4(p, r), p, r, 4);
    const a = (x: number, y: number) => out[(y * 32 + x) * 4 + 3]!;
    expect(a(5, 2)).toBe(0);
    expect(a(5, 29)).toBe(255);
    for (let y = 1; y < 32; y++) expect(a(5, y)).toBeGreaterThanOrEqual(a(5, y - 1)); // a ramp, not blocks
  });

  it('fitsOutput: the upscaled image is capped at 16 MP', () => {
    expect(MAX_OUTPUT_PIXELS).toBe(16_000_000);
    expect(fitsOutput(2000, 2000, 2)).toBe(true); // 16 MP exactly
    expect(fitsOutput(2001, 2000, 2)).toBe(false);
    expect(fitsOutput(1600, 1200, 2)).toBe(true);
    expect(fitsOutput(1600, 1200, 4)).toBe(false);
    expect(fitsOutput(1000, 1000, 4)).toBe(true);
  });
});
