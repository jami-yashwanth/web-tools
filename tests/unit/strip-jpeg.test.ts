import { readFileSync } from 'node:fs';
import exifr from 'exifr';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { decode } from '../../src/engine/decode';
import { imagesToPdf } from '../../src/pdf/images-to-pdf';
import { stripJpegMetadata } from '../../src/pdf/strip-jpeg';
import { useNodeWasm } from '../helpers/node-codecs';

const photo = new Uint8Array(readFileSync('tests/fixtures/photo.jpg')); // carries EXIF with GPS
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** The markers of a JPEG's header segments, up to the start of scan. */
function markers(b: Uint8Array): number[] {
  const out: number[] = [];
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const m = b[p + 1]!;
    out.push(m);
    if (m === 0xda) break;
    p += 2 + ((b[p + 2]! << 8) | b[p + 3]!);
  }
  return out;
}

beforeAll(() => useNodeWasm());

describe('stripJpegMetadata', () => {
  it('the fixture has location data to strip', async () => {
    expect(await exifr.gps(photo)).toMatchObject({ latitude: expect.any(Number) });
    expect(markers(photo)).toContain(0xe1);
  });

  it('removes APP1 (EXIF, XMP) and APP13 (IPTC): no EXIF or GPS is left, and the picture still decodes', async () => {
    const out = stripJpegMetadata(photo);
    expect(markers(out)).not.toContain(0xe1);
    expect(markers(out)).not.toContain(0xed);
    expect(markers(out).at(-1)).toBe(0xda);
    expect(await exifr.gps(out)).toBeUndefined();
    expect(await exifr.parse(out)).toBeUndefined();
    const before = await decode(ab(photo), 'jpg');
    const after = await decode(ab(out), 'jpg');
    expect([after.width, after.height]).toEqual([before.width, before.height]);
    expect(Buffer.from(after.data).equals(Buffer.from(before.data))).toBe(true); // lossless: the same pixels
  });

  it('keeps everything else byte for byte (the scan data, tables, ICC profile)', () => {
    const out = stripJpegMetadata(photo);
    const sos = (b: Uint8Array) => {
      let p = 2;
      while (b[p + 1] !== 0xda) p += 2 + ((b[p + 2]! << 8) | b[p + 3]!);
      return p;
    };
    expect(Buffer.from(out.subarray(sos(out))).equals(Buffer.from(photo.subarray(sos(photo))))).toBe(true);
    expect(markers(out)).toEqual(markers(photo).filter((m) => m !== 0xe1 && m !== 0xed));
  });

  it('removes an APP13 segment too, and leaves a JPEG without metadata as it is', () => {
    // SOI, APP0 (JFIF, 16 bytes), APP13 (6 bytes), SOS (header 8 bytes), a scan byte, EOI.
    const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const app13 = [0xff, 0xed, 0x00, 0x06, 0x50, 0x68, 0x6f, 0x74];
    const rest = [0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0x12, 0xff, 0xd9];
    const withIptc = new Uint8Array([0xff, 0xd8, ...app0, ...app13, ...rest]);
    expect([...stripJpegMetadata(withIptc)]).toEqual([0xff, 0xd8, ...app0, ...rest]);
    const plain = new Uint8Array([0xff, 0xd8, ...app0, ...rest]);
    expect(stripJpegMetadata(plain)).toBe(plain);
  });

  it('leaves bytes it cannot follow as they are (the embed reports them)', () => {
    const notJpeg = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    expect(stripJpegMetadata(notJpeg)).toBe(notJpeg);
    const cut = photo.subarray(0, 10); // a segment longer than the file
    expect(stripJpegMetadata(cut)).toBe(cut);
  });
});

describe('JPG to PDF: no location data in the PDF', () => {
  it("the PDF's embedded JPEG has no APP1 segment and no GPS", async () => {
    const { bytes } = await imagesToPdf([{ bytes: photo, kind: 'jpg', width: 1600, height: 1200 }], 'fit');
    const doc = await PDFDocument.load(bytes);
    const images = doc.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
    expect(images).toHaveLength(1);
    const jpeg = images[0]!.contents;
    expect(images[0]!.dict.get(PDFName.of('Filter'))).toBe(PDFName.of('DCTDecode'));
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    expect(markers(jpeg)).not.toContain(0xe1);
    expect(await exifr.gps(jpeg)).toBeUndefined();
    expect(Buffer.from(jpeg).equals(Buffer.from(stripJpegMetadata(photo)))).toBe(true);
  });
});
