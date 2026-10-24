// Pure sizing for PDF to JPG. No DOM and no pdf.js here, so the page and the tests can import it freely.

/** The most pixels one page may take: 25 MP is 100 MB of RGBA, the most a phone browser can be trusted with. */
export const MAX_PAGE_PIXELS = 25_000_000;

export interface Scale {
  /** pdf.js viewport scale: 1 is 72 dpi. */
  scale: number;
  /** The resolution actually used when it is one of the two on offer; a page too big even for 150 dpi still reports 150. */
  dpi: 150 | 300;
  /** True when the dpi asked for would have passed MAX_PAGE_PIXELS. */
  capped: boolean;
}

/**
 * Pick the render scale for a page of `pageWidthPt` x `pageHeightPt` points. Wanted dpi if it fits in 25 MP, else 150,
 * else the largest scale that does fit. Callers floor the pixel size, so the result never passes the cap.
 */
export function renderScale(pageWidthPt: number, pageHeightPt: number, dpi: 150 | 300): Scale {
  const area = pageWidthPt * pageHeightPt;
  const fits = (scale: number) => area * scale * scale <= MAX_PAGE_PIXELS;
  const wanted = dpi / 72;
  if (fits(wanted)) return { scale: wanted, dpi, capped: false };
  if (dpi === 300 && fits(150 / 72)) return { scale: 150 / 72, dpi: 150, capped: true };
  return { scale: Math.sqrt(MAX_PAGE_PIXELS / area), dpi: 150, capped: true };
}

/** The most pixels one whole document may take at 300 dpi; past it the remaining pages are drawn at 150 dpi. */
export const MAX_DOCUMENT_PIXELS = 500_000_000;

/** The canvas size for a viewport: whole pixels, never zero, never past the page cap (floor keeps it under). */
export function canvasSize(viewportWidth: number, viewportHeight: number): { width: number; height: number } {
  return { width: Math.max(1, Math.floor(viewportWidth)), height: Math.max(1, Math.floor(viewportHeight)) };
}

/**
 * The scale for one page, given the pixels the earlier pages already used. As renderScale, except that once the
 * document would pass MAX_DOCUMENT_PIXELS at 300 dpi, the page is drawn at 150 dpi and reported as capped.
 */
export function pageScale(pageWidthPt: number, pageHeightPt: number, dpi: 150 | 300, usedPixels: number): Scale {
  const r = renderScale(pageWidthPt, pageHeightPt, dpi);
  const { width, height } = canvasSize(pageWidthPt * r.scale, pageHeightPt * r.scale);
  if (r.dpi === 300 && usedPixels + width * height > MAX_DOCUMENT_PIXELS) {
    return { ...renderScale(pageWidthPt, pageHeightPt, 150), capped: true };
  }
  return r;
}

/** Did a canvas, a blob or an allocation fail for lack of memory? (A RangeError, or an error that says so.) */
export function isMemoryError(err: unknown): boolean {
  return err instanceof RangeError || (err instanceof Error && /memory|alloc|too large|too big/i.test(err.message));
}

/** The most pixels JPG to PDF will decode to re-encode a rotated JPEG: what one canvas can be trusted with on a phone. */
export const MAX_REENCODE_PIXELS = 50_000_000;
