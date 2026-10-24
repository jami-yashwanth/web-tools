import { AiError, type AiErrorDetail, type AiFail } from './errors';

// The message protocol between an AI tool's page and its worker. A worker answers each job with any number of
// progress messages, then exactly one done or failed.
export type AiWorkerRequest<Req> = { kind: 'job'; id: string; req: Req };
export type AiStage = 'download' | 'work';
export interface AiProgress {
  stage: AiStage;
  done: number;
  total: number;
  /** Work done so far that the page can show before the job ends (Transcribe audio: the latest segments). */
  partial?: unknown;
}
export type AiWorkerResponse<Res> =
  | ({ kind: 'progress'; id: string } & AiProgress)
  | { kind: 'done'; id: string; result: Res }
  | ({ kind: 'failed'; id: string; reason: AiFail } & Pick<AiErrorDetail, 'badModel' | 'detectedType'>);

export interface AiEngine<Req, Res> {
  /** Run one job. Jobs run strictly one at a time, in order. Rejects with AiError. */
  run(req: Req, transfer?: Transferable[], onProgress?: (p: AiProgress) => void, signal?: AbortSignal): Promise<Res>;
}

interface Pending<Req, Res> {
  id: string;
  req: Req;
  transfer: Transferable[];
  onProgress?: (p: AiProgress) => void;
  resolve: (r: Res) => void;
  reject: (e: AiError) => void;
  dispose: () => void;
}

/**
 * Main-thread wrapper around one AI tool's worker, after src/pdf/client.ts. A worker that dies before its first
 * message never loaded (network: its script or model could not be fetched); one that dies after it crashed mid-job
 * (corrupt). Either way the next job gets a fresh worker. Aborting a running job terminates the worker.
 */
export function createAiEngine<Req, Res>(workerFactory: () => Worker): AiEngine<Req, Res> {
  const queue: Pending<Req, Res>[] = [];
  let inFlight: Pending<Req, Res> | null = null;
  let worker: Worker | null = null;
  /** Has the current worker posted anything yet? An error before its first message means the script never loaded. */
  let heardFromWorker = false;
  let seq = 0;

  function getWorker(): Worker {
    if (worker) return worker;
    const w = workerFactory();
    heardFromWorker = false;
    w.onmessage = (e: MessageEvent<AiWorkerResponse<Res>>) => {
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

  function retire(): void {
    worker?.terminate();
    worker = null;
  }

  function finish(job: Pending<Req, Res>, outcome: { result: Res } | { reason: AiFail; detail?: AiErrorDetail }): void {
    if (inFlight === job) inFlight = null;
    job.dispose();
    if ('result' in outcome) job.resolve(outcome.result);
    else job.reject(new AiError(outcome.reason, outcome.detail));
    next();
  }

  function next(): void {
    if (inFlight || !queue.length) return;
    const job = queue.shift()!;
    inFlight = job;
    try {
      const message: AiWorkerRequest<Req> = { kind: 'job', id: job.id, req: job.req };
      getWorker().postMessage(message, job.transfer);
    } catch (err) {
      // The worker could not even be created (blocked script, CSP, no Worker support).
      console.error('ai: could not start the worker', err);
      retire();
      finish(job, { reason: 'network' });
    }
  }

  function handle(m: AiWorkerResponse<Res>): void {
    const job = inFlight;
    if (!job || m.id !== job.id) return;
    if (m.kind === 'progress') {
      try {
        job.onProgress?.({ stage: m.stage, done: m.done, total: m.total, ...(m.partial !== undefined ? { partial: m.partial } : {}) });
      } catch (err) {
        console.error('ai: progress listener failed', err); // must never stop the queue
      }
      return;
    }
    if (m.kind === 'done') return finish(job, { result: m.result });
    // network: a browser may cache a failed import in the worker's module map. device / corrupt: the worker may be
    // out of memory or in a bad state (wasm heaps never shrink). Retire it, so the next job starts afresh.
    if (m.reason === 'network' || m.reason === 'device' || m.reason === 'corrupt') retire();
    const detail: AiErrorDetail = {};
    if (m.badModel) detail.badModel = true;
    if (m.detectedType) detail.detectedType = m.detectedType;
    finish(job, { reason: m.reason, detail });
  }

  function crash(): void {
    const reason: AiFail = heardFromWorker ? 'corrupt' : 'network';
    retire();
    if (inFlight) finish(inFlight, { reason });
    else next();
  }

  function cancel(job: Pending<Req, Res>): void {
    if (inFlight === job) {
      retire(); // the only way to stop a worker mid-job
      finish(job, { reason: 'cancelled' });
      return;
    }
    const i = queue.indexOf(job);
    if (i < 0) return; // already settled
    queue.splice(i, 1);
    job.dispose();
    job.reject(new AiError('cancelled'));
  }

  return {
    run(req, transfer = [], onProgress, signal) {
      return new Promise<Res>((resolve, reject) => {
        if (signal?.aborted) return reject(new AiError('cancelled'));
        const job: Pending<Req, Res> = {
          id: `ai-${++seq}`,
          req,
          transfer,
          onProgress,
          resolve,
          reject,
          dispose: () => signal?.removeEventListener('abort', onAbort),
        };
        const onAbort = () => cancel(job);
        signal?.addEventListener('abort', onAbort);
        queue.push(job);
        next();
      });
    },
  };
}
