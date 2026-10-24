import { rangesLabel } from './ranges';
import type { PdfFail, PdfOut, SplitMode } from './types';

export class PdfError extends Error {
  constructor(
    public reason: PdfFail,
    /** Which input (0-based) was at fault, when there is one. */
    public index?: number,
  ) {
    super(reason);
    this.name = 'PdfError';
  }
}

// pdf-lib is large: load it on first use, so it never counts toward a page's first-load budget.
type Lib = typeof import('./pdf-lib');

/** Load pdf-lib. A chunk that fails to load (offline, blocked) is codec-load, never a damaged file. */
export async function loadLib(): Promise<Lib> {
  try {
    return await import('./pdf-lib');
  } catch (err) {
    console.error('pdf: could not load pdf-lib', err);
    throw new PdfError('codec-load');
  }
}
const lib = loadLib;

/** The trailer and xref dictionaries (where /Encrypt lives) sit at the ends of the file; don't decode the middle. */
const SCAN_BYTES = 64 * 1024;
function mentionsEncrypt(bytes: ArrayBuffer): boolean {
  const latin1 = new TextDecoder('latin1');
  const head = latin1.decode(new Uint8Array(bytes, 0, Math.min(SCAN_BYTES, bytes.byteLength)));
  const tailStart = Math.max(0, bytes.byteLength - SCAN_BYTES);
  const tail = latin1.decode(new Uint8Array(bytes, tailStart));
  return /\/Encrypt\b/.test(head) || /\/Encrypt\b/.test(tail);
}

async function open(L: Lib, bytes: ArrayBuffer) {
  try {
    // No ignoreEncryption: we must never write out a file we could not really read.
    const doc = await L.PDFDocument.load(bytes);
    doc.getPageCount(); // pdf-lib loads some garbage leniently; this throws when there is no usable page tree
    return doc;
  } catch (err) {
    // pdf-lib only raises EncryptedPDFError once it has parsed the file. With AES-256 it often fails earlier, on the
    // encrypted objects, so fall back to looking for the /Encrypt entry.
    throw new PdfError(err instanceof L.EncryptedPDFError || mentionsEncrypt(bytes) ? 'encrypted' : 'corrupt');
  }
}

type Doc = Awaited<ReturnType<typeof open>>;

/** Copy the given pages of each source, in order, into a new document. Sources are loaded lazily, one at a time. */
async function build(L: Lib, name: string, sources: { load: () => Promise<Doc>; indices?: number[] }[]): Promise<PdfOut> {
  const out = await L.PDFDocument.create();
  for (const { load, indices } of sources) {
    const doc = await load();
    try {
      for (const page of await out.copyPages(doc, indices ?? doc.getPageIndices())) out.addPage(page);
    } catch {
      throw new PdfError('corrupt');
    }
  }
  try {
    return { name, bytes: await out.save(), pages: out.getPageCount() };
  } catch {
    throw new PdfError('corrupt');
  }
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);

export async function pageCount(bytes: ArrayBuffer): Promise<number> {
  const L = await lib();
  return (await open(L, bytes)).getPageCount();
}

export async function merge(files: ArrayBuffer[]): Promise<PdfOut> {
  if (!files.length) throw new PdfError('corrupt'); // never produce an empty PDF
  const L = await lib();
  return build(L, 'merged.pdf', files.map((bytes) => ({ load: () => open(L, bytes) })));
}

export async function split(bytes: ArrayBuffer, base: string, mode: SplitMode): Promise<PdfOut[]> {
  const L = await lib();
  const doc = await open(L, bytes);
  const load = async () => doc;
  if (mode.kind === 'every') {
    // One at a time: a 500-page file must not hold 500 documents in memory at once.
    const out: PdfOut[] = [];
    for (const i of doc.getPageIndices()) out.push(await build(L, `${base}-page-${i + 1}.pdf`, [{ load, indices: [i] }]));
    return out;
  }
  const indices = mode.ranges.flatMap(([s, e]) => range(s, e));
  return [await build(L, `${base}-pages-${rangesLabel(mode.ranges)}.pdf`, [{ load, indices }])];
}
