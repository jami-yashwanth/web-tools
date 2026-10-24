import { describe, expect, it } from 'vitest';
import { canvasSize, isMemoryError, MAX_DOCUMENT_PIXELS, MAX_PAGE_PIXELS, pageScale, renderScale } from '../../src/pdf/raster';

const pixels = (w: number, h: number, scale: number) => Math.floor(w * scale) * Math.floor(h * scale);

describe('renderScale', () => {
  it('draws a Letter page at 300 dpi in full', () => {
    expect(renderScale(612, 792, 300)).toEqual({ scale: 300 / 72, dpi: 300, capped: false });
  });
  it('draws a Letter page at 150 dpi in full', () => {
    expect(renderScale(612, 792, 150)).toEqual({ scale: 150 / 72, dpi: 150, capped: false });
  });
  it('falls back to 150 dpi when 300 would pass 25 MP, and says so', () => {
    // A2, 1191 x 1684 pt: 300 dpi is ~35 MP, 150 dpi is ~8.7 MP.
    const r = renderScale(1191, 1684, 300);
    expect(r).toEqual({ scale: 150 / 72, dpi: 150, capped: true });
    expect(pixels(1191, 1684, r.scale)).toBeLessThanOrEqual(MAX_PAGE_PIXELS);
  });
  it('shrinks below 150 dpi when even that would pass 25 MP', () => {
    const r = renderScale(5000, 5000, 300);
    expect(r.capped).toBe(true);
    expect(r.scale).toBeLessThan(150 / 72);
    expect(pixels(5000, 5000, r.scale)).toBeLessThanOrEqual(MAX_PAGE_PIXELS);
    expect(pixels(5000, 5000, r.scale)).toBeGreaterThan(MAX_PAGE_PIXELS * 0.98); // as large as the cap allows
  });
  it('caps a 150 dpi request too', () => {
    const r = renderScale(5000, 5000, 150);
    expect(r.capped).toBe(true);
    expect(pixels(5000, 5000, r.scale)).toBeLessThanOrEqual(MAX_PAGE_PIXELS);
  });
})

describe('canvasSize', () => {
  it('is never zero, even for a sliver of a page', () => {
    expect(canvasSize(0.4, 0.2)).toEqual({ width: 1, height: 1 });
  });
  it('rounds down, so a page at the cap stays under it', () => {
    const r = renderScale(5000, 5000, 300);
    const c = canvasSize(5000 * r.scale, 5000 * r.scale);
    expect(c.width * c.height).toBeLessThanOrEqual(MAX_PAGE_PIXELS);
  });
});

describe('pageScale (the whole-file budget)', () => {
  it('is renderScale while the file is inside 500 MP', () => {
    expect(pageScale(612, 792, 300, 0)).toEqual(renderScale(612, 792, 300));
  });
  it('draws at 150 dpi, and says so, once 300 dpi would pass the budget', () => {
    // A Letter page at 300 dpi is ~8.7 MP: 495 MP used leaves no room for it.
    const r = pageScale(612, 792, 300, MAX_DOCUMENT_PIXELS - 1_000_000);
    expect(r).toEqual({ scale: 150 / 72, dpi: 150, capped: true });
  });
  it('leaves a 150 dpi request alone', () => {
    expect(pageScale(612, 792, 150, MAX_DOCUMENT_PIXELS)).toEqual({ scale: 150 / 72, dpi: 150, capped: false });
  });
});

describe('isMemoryError', () => {
  it('knows a RangeError and messages that say memory', () => {
    expect(isMemoryError(new RangeError('Array buffer allocation failed'))).toBe(true);
    expect(isMemoryError(new Error('Out of memory'))).toBe(true);
    expect(isMemoryError(new Error('Canvas exceeds max size'))).toBe(false);
    expect(isMemoryError(new Error('Invalid PDF structure'))).toBe(false);
    expect(isMemoryError('nope')).toBe(false);
  });
});
