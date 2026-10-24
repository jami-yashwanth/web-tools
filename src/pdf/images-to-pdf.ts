import { loadLib, PdfError } from './ops';
import { stripJpegMetadata } from './strip-jpeg';
import type { PageSize } from './types';

export interface PdfImage {
  bytes: Uint8Array;
  kind: 'jpg' | 'png';
  width: number;
  height: number;
}

const PX_TO_PT = 0.75; // 96 px per inch, 72 pt per inch
const MARGIN = 36;
const PAGE: Record<'a4' | 'letter', [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] };

export interface Layout {
  pageWidth: number;
  pageHeight: number;
  /** Where the image's lower-left corner goes, and its drawn size, in points. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * "Fit to image": a page exactly the size of the image. A4 and Letter: a portrait page with 36 pt margins; the image is
 * centred, at its own size unless that is too big for the margins, in which case it shrinks to fit (never enlarges).
 */
export function layout(imageWidth: number, imageHeight: number, size: PageSize): Layout {
  const w = imageWidth * PX_TO_PT;
  const h = imageHeight * PX_TO_PT;
  if (size === 'fit') return { pageWidth: w, pageHeight: h, x: 0, y: 0, width: w, height: h };
  const [pageWidth, pageHeight] = PAGE[size];
  const shrink = Math.min(1, (pageWidth - 2 * MARGIN) / w, (pageHeight - 2 * MARGIN) / h);
  const width = w * shrink;
  const height = h * shrink;
  return { pageWidth, pageHeight, x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height };
}

/**
 * One page per image, in the order given. JPEG and PNG bytes are embedded as they are, not re-encoded; a JPEG loses
 * its metadata segments first (EXIF with its GPS, XMP, IPTC: see strip-jpeg.ts), losslessly.
 */
export async function imagesToPdf(images: PdfImage[], size: PageSize): Promise<{ bytes: Uint8Array; pages: number }> {
  if (!images.length) throw new PdfError('corrupt'); // never produce an empty PDF
  const L = await loadLib();
  try {
    const doc = await L.PDFDocument.create();
    for (const [i, img] of images.entries()) {
      let embedded;
      try {
        embedded = img.kind === 'jpg' ? await doc.embedJpg(stripJpegMetadata(img.bytes)) : await doc.embedPng(img.bytes);
      } catch {
        throw new PdfError('corrupt', i);
      }
      const l = layout(img.width, img.height, size);
      const page = doc.addPage([l.pageWidth, l.pageHeight]);
      page.drawImage(embedded, { x: l.x, y: l.y, width: l.width, height: l.height });
    }
    return { bytes: await doc.save(), pages: images.length };
  } catch (err) {
    throw err instanceof PdfError ? err : new PdfError('corrupt');
  }
}
