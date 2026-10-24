import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AiError } from '../../src/ai/errors';
import { assertTraineddata, recogniseBytes, toPng } from '../../src/ai/ocr/core';
import { sniff } from '../../src/engine/sniff';
import { useNodeWasm } from '../helpers/node-codecs';

// Real tesseract.js (its Node worker) with the real tessdata_fast `eng` model from the committed fixture.

const fixture = (...p: string[]): Buffer => readFileSync(resolve(__dirname, '../fixtures', ...p));
const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
/** A directory holding `eng.traineddata.gz`, as tesseract's Node worker reads language data from a path. */
const modelDir = (bytes: Uint8Array): { langPath: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'ocr-test-'));
  writeFileSync(join(dir, 'eng.traineddata.gz'), bytes);
  return { langPath: dir };
};
const MODEL = () => modelDir(fixture('models', 'tessdata', 'eng.traineddata.gz'));

beforeAll(useNodeWasm);

describe('recogniseBytes (real tesseract.js, eng fast model)', () => {
  it('reads the text in an image, with a confidence', async () => {
    const progress: number[] = [];
    const { text, confidence } = await recogniseBytes(ab(fixture('ocr', 'hello.png')), MODEL(), (done, total) =>
      progress.push(done / total),
    );
    expect(text).toContain('quick brown fox');
    expect(text).toContain('12345');
    expect(confidence).toBeGreaterThan(70);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]!)).toBe(true); // never backwards
  }, 60_000);

  it('applies the EXIF orientation first: a JPG stored sideways reaches tesseract upright, and still reads', async () => {
    const bytes = ab(fixture('ocr', 'hello-rotated-6.jpg'));
    // Stored 160 x 900, Orientation 6 (turn a quarter clockwise): the PNG tesseract gets is 900 x 160.
    expect(await sniff(new Blob([await toPng(bytes)] as BlobPart[]))).toMatchObject({ type: 'png', width: 900, height: 160 });
    const { text } = await recogniseBytes(bytes, MODEL());
    expect(text).toContain('quick brown fox');
    expect(text).toContain('12345');
  }, 60_000);

  it('returns empty text for a blank image', async () => {
    const { text } = await recogniseBytes(ab(fixture('ocr', 'blank.png')), MODEL());
    expect(text.trim()).toBe('');
  }, 60_000);

  it('accepts the real model', async () => {
    await expect(assertTraineddata(new Uint8Array(fixture('models', 'tessdata', 'eng.traineddata.gz')))).resolves.toBeUndefined();
  });

  it.each([
    ['an error page', new TextEncoder().encode('<html>Not found</html>')],
    ['zeros', new Uint8Array(4000)],
    ['a truncated download', new Uint8Array(fixture('models', 'tessdata', 'eng.traineddata.gz')).slice(0, 100_000)],
  ])('rejects %s as a bad model, not a bad file', async (_name, bytes) => {
    const err = await assertTraineddata(bytes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ reason: 'network', badModel: true });
  });

  it('rejects an image it cannot decode as corrupt', async () => {
    const err = await recogniseBytes(ab(fixture('ocr', 'hello.png')).slice(0, 40), MODEL()).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'corrupt' });
  }, 60_000);
});
