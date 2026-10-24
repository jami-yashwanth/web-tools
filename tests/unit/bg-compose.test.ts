import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_MEGAPIXELS,
  MODEL_SIZE,
  composeRGBA,
  normaliseMask,
  prepareInput,
  toModelInput,
  upsampleMask,
} from '../../src/ai/bg/compose';
import { decode, type Pixels } from '../../src/engine/decode';
import { useNodeWasm } from '../helpers/node-codecs';

beforeAll(useNodeWasm);

const fixture = (name: string) => {
  const b = readFileSync(resolve(__dirname, '../fixtures', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const pixels = (width: number, height: number, rgba: number[], hasAlpha = false): Pixels => ({
  data: new Uint8ClampedArray(rgba),
  width,
  height,
  orientation: 1,
  hasAlpha,
});

describe('upsampleMask', () => {
  it('a 2×2 mask upsampled to 4×4 gives the expected bilinear values (pixel centres aligned, edges clamped)', () => {
    // Left column 0, right column 1.
    const out = upsampleMask(new Float32Array([0, 1, 0, 1]), 2, 2, 4, 4);
    const row = [0, 64, 191, 255];
    expect([...out]).toEqual([...row, ...row, ...row, ...row]);
  });

  it('interpolates vertically too, and clamps values outside 0..1', () => {
    const out = upsampleMask(new Float32Array([0, 0, 1.5, -0.5]), 2, 2, 2, 4);
    // Column 0 goes 0 → 1 (clamped from 1.5), column 1 stays 0 (clamped from -0.5).
    expect([...out]).toEqual([0, 0, 64, 0, 191, 0, 255, 0]);
  });

  it('a same-size mask is a straight copy scaled to 0..255', () => {
    expect([...upsampleMask(new Float32Array([0, 0.5, 1]), 3, 1, 3, 1)]).toEqual([0, 128, 255]);
  });
});

describe('normaliseMask', () => {
  it('stretches the prediction to fill 0..1, as U²-Net output is used', () => {
    expect([...normaliseMask(new Float32Array([0.2, 0.4, 0.6]))].map((v) => +v.toFixed(3))).toEqual([0, 0.5, 1]);
  });
  it('a flat prediction stays as it is (no divide by zero)', () => {
    expect([...normaliseMask(new Float32Array([0.3, 0.3]))].map((v) => +v.toFixed(3))).toEqual([0.3, 0.3]);
  });
});

describe('composeRGBA', () => {
  const px = () => pixels(3, 1, [200, 100, 50, 255, 10, 20, 30, 255, 90, 80, 70, 128], true);
  const alpha = new Uint8ClampedArray([0, 255, 255]);

  it('with transparent keeps RGB and sets alpha (combined with any alpha the photo had)', () => {
    const out = composeRGBA(px(), alpha, 'transparent');
    expect([...out.data]).toEqual([200, 100, 50, 0, 10, 20, 30, 255, 90, 80, 70, 128]);
    expect(out.hasAlpha).toBe(true);
    expect([out.width, out.height, out.orientation]).toEqual([3, 1, 1]);
  });

  it('with white blends to white where alpha is 0, keeps the subject where it is 255, and is opaque', () => {
    const out = composeRGBA(px(), alpha, { r: 255, g: 255, b: 255 });
    expect([...out.data.subarray(0, 8)]).toEqual([255, 255, 255, 255, 10, 20, 30, 255]);
    // Half-transparent source pixel: halfway to white.
    expect([...out.data.subarray(8)]).toEqual([172, 167, 162, 255]);
    expect(out.hasAlpha).toBe(false);
  });

  it('with a colour blends towards that colour', () => {
    const out = composeRGBA(pixels(1, 1, [0, 0, 0, 255]), new Uint8ClampedArray([51]), { r: 255, g: 0, b: 100 });
    expect([...out.data]).toEqual([204, 0, 80, 255]);
  });

  it('never changes the photo it was given (the mask is re-used for each background)', () => {
    const p = px();
    const before = [...p.data];
    composeRGBA(p, alpha, { r: 0, g: 0, b: 0 });
    composeRGBA(p, alpha, 'transparent');
    expect([...p.data]).toEqual(before);
  });
});

describe('toModelInput', () => {
  it(`is a 1×3×${MODEL_SIZE}×${MODEL_SIZE} planar tensor normalised with the ImageNet mean and std`, () => {
    const t = toModelInput(pixels(1, 1, [255, 0, 124, 255]));
    expect(t.length).toBe(3 * MODEL_SIZE * MODEL_SIZE);
    const plane = MODEL_SIZE * MODEL_SIZE;
    expect(t[0]).toBeCloseTo((1 - 0.485) / 0.229, 4);
    expect(t[plane]).toBeCloseTo((0 - 0.456) / 0.224, 4);
    expect(t[2 * plane]).toBeCloseTo((124 / 255 - 0.406) / 0.225, 4);
  });

  it('stretches the photo to the square input: left half red, right half blue stays left and right', () => {
    const w = 640;
    const h = 100;
    const data: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.push(x < w / 2 ? 255 : 0, 0, x < w / 2 ? 0 : 255, 255);
    const t = toModelInput(pixels(w, h, data));
    const plane = MODEL_SIZE * MODEL_SIZE;
    const red = (x: number, y: number) => t[y * MODEL_SIZE + x]!;
    const blue = (x: number, y: number) => t[2 * plane + y * MODEL_SIZE + x]!;
    expect(red(10, 300)).toBeGreaterThan(2);
    expect(blue(10, 300)).toBeLessThan(-1);
    expect(red(310, 10)).toBeLessThan(-2);
    expect(blue(310, 10)).toBeGreaterThan(2);
  });
});

describe('prepareInput', () => {
  it('a rotated-6.heic-derived Pixels input keeps orientation: it is turned upright before inference', async () => {
    const raw = await decode(fixture('rotated-6.heic'), 'heic');
    expect([raw.width, raw.height, raw.orientation]).toEqual([400, 300, 6]);
    const { pixels: upright, downscaled } = prepareInput(raw);
    expect([upright.width, upright.height, upright.orientation]).toEqual([300, 400, 1]);
    expect(downscaled).toBe(false);
    // The stored top-left pixel is now at the top-right, which is what the model and the mask see.
    expect([...upright.data.subarray((300 - 1) * 4, 300 * 4)]).toEqual([...raw.data.subarray(0, 4)]);
  });

  it('a rotated-6.jpg turns upright too', async () => {
    const raw = await decode(fixture('rotated-6.jpg'), 'jpg');
    const { pixels: upright } = prepareInput(raw);
    expect([upright.width, upright.height, upright.orientation]).toEqual([raw.height, raw.width, 1]);
  });

  it(`a photo over ${MAX_MEGAPIXELS} MP is downscaled to ${MAX_MEGAPIXELS} MP first, and says so`, () => {
    const big: Pixels = { data: new Uint8ClampedArray(6000 * 4500 * 4), width: 6000, height: 4500, orientation: 1, hasAlpha: false };
    const { pixels: out, downscaled } = prepareInput(big);
    expect(downscaled).toBe(true);
    expect(out.width * out.height).toBeLessThanOrEqual(MAX_MEGAPIXELS * 1e6);
    expect(out.width * out.height).toBeGreaterThan(MAX_MEGAPIXELS * 1e6 * 0.99);
    expect(out.width / out.height).toBeCloseTo(6000 / 4500, 2);
  });
});
