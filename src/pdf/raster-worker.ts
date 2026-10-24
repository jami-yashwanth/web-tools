import { PdfError } from './ops';
import { canvasSize, isMemoryError, pageScale } from './raster';
import type { ImageFormat, PdfOut, PdfRequest, RasterOut } from './types';
import { serve, type EmitPage } from './worker-host';

// PDF to JPG. pdf.js runs right here, in this worker: its own "main-thread" mode, fed the parser module through
// `globalThis.pdfjsWorker`, so it never starts a second worker and works the same in every browser. Both pdf.js modules
// are dynamic imports, so they are their own chunks, fetched only once a PDF is on the page.

type Pdfjs = typeof import('pdfjs-dist');

/** Where the build put pdf.js's font, CMap and wasm data, by file name. The build only fetches them if a PDF needs them. */
const assets = {
  standardFontDataUrl: import.meta.glob('../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { query: '?url&no-inline', import: 'default', eager: true }),
  cMapUrl: import.meta.glob('../../node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url&no-inline', import: 'default', eager: true }),
  wasmUrl: import.meta.glob('../../node_modules/pdfjs-dist/wasm/{jbig2,openjpeg}.wasm', { query: '?url&no-inline', import: 'default', eager: true }),
} as const;

/** pdf.js asks for these by file name; we answer from the files the build emitted. */
class BuiltInData {
  async fetch({ kind, filename }: { kind: keyof typeof assets; filename: string }): Promise<Uint8Array> {
    const found = Object.entries(assets[kind]).find(([path]) => path.endsWith(`/${filename}`));
    if (!found) throw new Error(`pdf.js asked for ${kind} ${filename}, which is not bundled`);
    return new Uint8Array(await (await fetch(found[1] as string)).arrayBuffer());
  }
}

/** pdf.js's default canvas factory wants `document`, which a worker doesn't have. */
class WorkerCanvasFactory {
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(c: { canvas: OffscreenCanvas }, width: number, height: number) {
    c.canvas.width = width;
    c.canvas.height = height;
  }
  destroy(c: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (c.canvas) c.canvas.width = c.canvas.height = 0;
    c.canvas = null;
    c.context = null;
  }
}

let loaded: Promise<Pdfjs> | undefined;
/** Load pdf.js. A chunk that fails to load (offline, blocked) is codec-load, never a damaged file. */
function loadPdfjs(): Promise<Pdfjs> {
  loaded ??= (async () => {
    try {
      const [lib, parser] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.mjs')]);
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = parser;
      return lib;
    } catch (err) {
      console.error('pdf: could not load pdf.js', err);
      loaded = undefined; // a retry loads afresh
      throw new PdfError('codec-load');
    }
  })();
  return loaded;
}

async function open(lib: Pdfjs, bytes: ArrayBuffer) {
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    CanvasFactory: WorkerCanvasFactory,
    BinaryDataFactory: BuiltInData,
    useWorkerFetch: false,
    disableFontFace: true, // glyphs drawn as paths: no FontFace, no DOM
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  } as Parameters<Pdfjs['getDocument']>[0]);
  try {
    return { doc: await task.promise, close: () => task.destroy() };
  } catch (err) {
    await task.destroy().catch(() => {});
    throw new PdfError((err as { name?: string })?.name === 'PasswordException' ? 'encrypted' : 'corrupt');
  }
}

const MIME: Record<ImageFormat, string> = { jpg: 'image/jpeg', png: 'image/png' };
// Page images use convertToBlob (the canvas route the v1 image engine avoids, because it caps what it can hold): safe
// here because every page is capped at 25 MP by renderScale, well inside what a canvas can encode.
const JPEG_QUALITY = 0.85;

async function pageCount(bytes: ArrayBuffer): Promise<number> {
  const lib = await loadPdfjs();
  const { doc, close } = await open(lib, bytes);
  try {
    return doc.numPages;
  } finally {
    await close();
  }
}

async function rasterize(bytes: ArrayBuffer, base: string, format: ImageFormat, dpi: 150 | 300, emit: EmitPage): Promise<RasterOut> {
  const lib = await loadPdfjs();
  const { doc, close } = await open(lib, bytes);
  let capped = false;
  let used = 0; // pixels drawn so far, for the whole-file budget
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        const { width: w, height: h } = page.getViewport({ scale: 1 });
        const r = pageScale(w, h, dpi, used);
        capped ||= r.capped;
        const viewport = page.getViewport({ scale: r.scale });
        const size = canvasSize(viewport.width, viewport.height);
        used += size.width * size.height;
        const canvas = new OffscreenCanvas(size.width, size.height);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#fff'; // a page has no transparency: JPEG would turn it black
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
        const blob = await canvas.convertToBlob(format === 'jpg' ? { type: MIME.jpg, quality: JPEG_QUALITY } : { type: MIME.png });
        canvas.width = canvas.height = 0; // let go of the pixels now, not when the GC gets to it
        // Out it goes at once: this worker never holds more than the page it is on.
        emit({ name: `${base}-page-${n}.${format}`, n, total: doc.numPages, bytes: new Uint8Array(await blob.arrayBuffer()) });
      } finally {
        page.cleanup();
      }
    }
  } catch (err) {
    if (err instanceof PdfError) throw err;
    if (isMemoryError(err)) throw new PdfError('memory');
    console.error('pdf: could not draw a page', err);
    throw new PdfError('corrupt');
  } finally {
    await close();
  }
  return { count: doc.numPages, capped };
}

async function run(msg: PdfRequest, emit: EmitPage): Promise<number | PdfOut | RasterOut> {
  switch (msg.op) {
    case 'warm':
      await loadPdfjs();
      return 0;
    case 'count':
      return pageCount(msg.bytes);
    case 'rasterize':
      return rasterize(msg.bytes, msg.base, msg.format, msg.dpi, emit);
    default:
      throw new PdfError('corrupt'); // served by worker.ts
  }
}

serve(run);
