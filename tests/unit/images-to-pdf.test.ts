import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { imagesToPdf, layout } from '../../src/pdf/images-to-pdf';

const jpg = new Uint8Array(readFileSync('tests/fixtures/photo.jpg'));
const png = new Uint8Array(readFileSync('tests/fixtures/alpha.png'));
const sizes = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((p) => p.getSize());
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

describe('layout', () => {
  it('fit: the page is the image, at 1 px = 0.75 pt', () => {
    expect(layout(800, 600, 'fit')).toEqual({ pageWidth: 600, pageHeight: 450, x: 0, y: 0, width: 600, height: 450 });
  });
  it('a4: 36 pt margins, small images keep their size and sit in the centre', () => {
    const l = layout(100, 100, 'a4');
    expect(near(l.pageWidth, 595.28) && near(l.pageHeight, 841.89)).toBe(true);
    expect(l.width).toBe(75);
    expect(near(l.x, (595.28 - 75) / 2) && near(l.y, (841.89 - 75) / 2)).toBe(true);
  });
  it('a4: big images shrink to fit inside the margins, centred', () => {
    const l = layout(3000, 1000, 'a4');
    expect(near(l.width, 595.28 - 72)).toBe(true);
    expect(near(l.height, (595.28 - 72) / 3)).toBe(true);
    expect(near(l.x, 36)).toBe(true);
    expect(near(l.y, (841.89 - l.height) / 2)).toBe(true);
  });
  it('letter: 612 x 792', () => {
    const l = layout(100, 4000, 'letter');
    expect([l.pageWidth, l.pageHeight]).toEqual([612, 792]);
    expect(near(l.height, 792 - 72)).toBe(true);
    expect(near(l.x, (612 - l.width) / 2)).toBe(true);
  });
});

describe('imagesToPdf', () => {
  it('fit: each page is its image size in points, in the given order', async () => {
    const out = await imagesToPdf(
      [
        { bytes: jpg, kind: 'jpg', width: 800, height: 600 },
        { bytes: png, kind: 'png', width: 400, height: 400 },
      ],
      'fit',
    );
    expect(out.pages).toBe(2);
    expect(new TextDecoder().decode(out.bytes.subarray(0, 4))).toBe('%PDF');
    const [a, b] = await sizes(out.bytes);
    expect([a!.width, a!.height, b!.width, b!.height]).toEqual([600, 450, 300, 300]);
  });
  it('a4 and letter give pages of that size for every image', async () => {
    const images = [{ bytes: jpg, kind: 'jpg' as const, width: 800, height: 600 }];
    const [a4] = await sizes((await imagesToPdf(images, 'a4')).bytes);
    expect(near(a4!.width, 595.28) && near(a4!.height, 841.89)).toBe(true);
    const [letter] = await sizes((await imagesToPdf(images, 'letter')).bytes);
    expect([letter!.width, letter!.height]).toEqual([612, 792]);
  });
  it('refuses an empty list', async () => {
    await expect(imagesToPdf([], 'fit')).rejects.toMatchObject({ reason: 'corrupt' });
  });
  it('a damaged image is corrupt', async () => {
    await expect(imagesToPdf([{ bytes: new Uint8Array([1, 2, 3]), kind: 'jpg', width: 1, height: 1 }], 'fit')).rejects.toMatchObject({ reason: 'corrupt' });
  });
  it('says which image was damaged', async () => {
    const good = { bytes: jpg, kind: 'jpg' as const, width: 800, height: 600 };
    const bad = { bytes: new Uint8Array([1, 2, 3]), kind: 'png' as const, width: 1, height: 1 };
    await expect(imagesToPdf([good, bad], 'fit')).rejects.toMatchObject({ reason: 'corrupt', index: 1 });
  });
});
