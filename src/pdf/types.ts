export type PdfFail = 'encrypted' | 'corrupt' | 'codec-load' | 'memory';
export interface PdfOut {
  name: string;
  bytes: Uint8Array;
  pages: number;
}

/** PDF to JPG: the pages arrive one by one as `page` messages; this is what is left when the last one is out. */
export interface RasterOut {
  count: number;
  /** At least one page was drawn smaller than the dpi asked for (too big for one page, or the whole file passed the budget). */
  capped: boolean;
}
/** One finished page image, named `<base>-page-<n>.<ext>`. Its bytes are transferred, not copied. */
export interface RasterPage {
  name: string;
  /** 1-based, and the page count of the whole file. */
  n: number;
  total: number;
  bytes: Uint8Array;
}
export type ImageFormat = 'jpg' | 'png';
export type PageSize = 'fit' | 'a4' | 'letter';
/** An image on its way into a PDF: JPEG or PNG bytes, with the pixel size they decode to. */
export interface ImageIn {
  bytes: ArrayBuffer;
  kind: ImageFormat;
  width: number;
  height: number;
}

export type SplitMode = { kind: 'every' } | { kind: 'ranges'; ranges: [number, number][] };

/** Page -> worker. File bytes travel as transferred ArrayBuffers. */
export type PdfRequest =
  | { kind: 'job'; id: string; op: 'warm' }
  | { kind: 'job'; id: string; op: 'count'; bytes: ArrayBuffer }
  | { kind: 'job'; id: string; op: 'merge'; files: ArrayBuffer[] }
  | { kind: 'job'; id: string; op: 'split'; bytes: ArrayBuffer; base: string; mode: SplitMode }
  | { kind: 'job'; id: string; op: 'rasterize'; bytes: ArrayBuffer; base: string; format: ImageFormat; dpi: 150 | 300 }
  | { kind: 'job'; id: string; op: 'images'; images: ImageIn[]; size: PageSize };

/** Worker -> page. */
export type PdfResponse =
  | { kind: 'done'; id: string; result: number | PdfOut | PdfOut[] | RasterOut }
  | ({ kind: 'page'; id: string } & RasterPage)
  | { kind: 'failed'; id: string; reason: PdfFail; /** the image (0-based) that could not be used, for JPG to PDF */ index?: number };
