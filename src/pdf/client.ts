import { PdfError } from './ops';
import type { ImageFormat, ImageIn, PageSize, PdfOut, PdfRequest, PdfResponse, RasterOut, RasterPage, SplitMode } from './types';

export interface PdfEngine {
  /** Load pdf-lib in the worker ahead of the first real job. Rejects with codec-load if it can't. */
  warm(): Promise<void>;
  count(id: string, file: File): Promise<number>;
  merge(files: File[]): Promise<PdfOut>;
  split(file: File, mode: SplitMode): Promise<PdfOut[]>;
  /** PDF to JPG/PNG (the raster worker only): one image per page. */
  rasterize(file: File, format: ImageFormat, dpi: 150 | 300, onPage: (page: RasterPage) => void): Promise<RasterOut>;
  /** JPG to PDF (the PDF worker only): one page per image, in order. */
  images(images: ImageIn[], size: PageSize): Promise<PdfOut>;
}

const defaultWorkerFactory = (): Worker => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

interface Pending {
  id: string;
  build: () => Promise<{ message: PdfRequest; transfer: ArrayBuffer[] }>;
  /** Receives each finished page of a rasterize job as it arrives. */
  onPage?: (page: RasterPage) => void;
  resolve: (result: never) => void;
  reject: (err: PdfError) => void;
}

const read = (file: File) => file.arrayBuffer();

export const rasterWorkerFactory = (): Worker => new Worker(new URL('./raster-worker.ts', import.meta.url), { type: 'module' });

/** Main-thread wrapper around a PDF worker (worker.ts, or raster-worker.ts for PDF to JPG). Runs jobs strictly one at a time, in order; rejections are PdfError. */
export function createPdfEngine(workerFactory: () => Worker = defaultWorkerFactory): PdfEngine {
  const queue: Pending[] = [];
  let inFlight: Pending | null = null;
  let worker: Worker | null = null;
  /** Has the current worker posted anything yet? An error before its first message means the script never loaded. */
  let heardFromWorker = false;
  let seq = 0;

  function getWorker(): Worker {
    if (worker) return worker;
    const w = workerFactory();
    heardFromWorker = false;
    w.onmessage = (e: MessageEvent<PdfResponse>) => {
      if (w !== worker) return;
      heardFromWorker = true;
      handle(e.data);
    };
    w.onerror = () => {
      if (w === worker) crash();
    };
    worker = w;
    return w;
  }

  function fail(job: Pending, reason: PdfError['reason'], index?: number): void {
    inFlight = null;
    job.reject(new PdfError(reason, index));
    next();
  }

  function next(): void {
    if (inFlight || !queue.length) return;
    const job = queue.shift()!;
    inFlight = job;
    job.build().then(
      ({ message, transfer }) => {
        if (inFlight !== job) return;
        try {
          getWorker().postMessage(message, transfer);
        } catch (err) {
          // The worker could not even be created (blocked script, CSP, no Worker support).
          console.error('pdf: could not start the worker', err);
          worker?.terminate();
          worker = null;
          fail(job, 'codec-load');
        }
      },
      () => fail(job, 'corrupt'), // the file could not be read (removed or unreadable)
    );
  }

  function handle(m: PdfResponse): void {
    if (!inFlight || m.id !== inFlight.id) return;
    if (m.kind === 'page') {
      const { kind: _, id: __, ...page } = m;
      inFlight.onPage?.(page);
      return;
    }
    const job = inFlight;
    inFlight = null;
    if (m.kind === 'done') job.resolve(m.result as never);
    else {
      // A browser may cache a failed import in the worker's module map: retire the worker so a retry loads afresh.
      if (m.reason === 'codec-load') retire();
      job.reject(new PdfError(m.reason, m.index));
    }
    next();
  }

  function retire(): void {
    worker?.terminate();
    worker = null;
  }

  /** Before the worker's first message its script failed to load (codec-load); after it, it died mid-job. */
  function crash(): void {
    const reason = heardFromWorker ? 'corrupt' : 'codec-load';
    retire();
    if (inFlight) fail(inFlight, reason);
    else next();
  }

  function enqueue<T>(id: string, build: Pending['build'], onPage?: Pending['onPage']): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({ id, build, onPage, resolve: resolve as (r: never) => void, reject });
      next();
    });
  }

  const jobId = (kind: string) => `${kind}-${++seq}`;

  return {
    async warm() {
      const id = jobId('warm');
      await enqueue<number>(id, async () => ({ message: { kind: 'job', id, op: 'warm' }, transfer: [] }));
    },
    count: (id, file) =>
      enqueue(id, async () => {
        const bytes = await read(file);
        return { message: { kind: 'job', id, op: 'count', bytes }, transfer: [bytes] };
      }),
    merge(files) {
      const id = jobId('merge');
      return enqueue(id, async () => {
        const buffers = await Promise.all(files.map(read));
        return { message: { kind: 'job', id, op: 'merge', files: buffers }, transfer: buffers };
      });
    },
    split(file, mode) {
      const id = jobId('split');
      const base = file.name.replace(/\.pdf$/i, '') || 'document';
      return enqueue(id, async () => {
        const bytes = await read(file);
        return { message: { kind: 'job', id, op: 'split', bytes, base, mode }, transfer: [bytes] };
      });
    },
    rasterize(file, format, dpi, onPage) {
      const id = jobId('raster');
      const base = file.name.replace(/\.pdf$/i, '') || 'document';
      return enqueue(
        id,
        async () => {
          const bytes = await read(file);
          return { message: { kind: 'job', id, op: 'rasterize', bytes, base, format, dpi }, transfer: [bytes] };
        },
        onPage,
      );
    },
    images(images, size) {
      const id = jobId('images');
      return enqueue(id, async () => ({
        message: { kind: 'job', id, op: 'images', images, size },
        transfer: images.map((i) => i.bytes),
      }));
    },
  };
}
