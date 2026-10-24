import { describe, expect, it } from 'vitest';
import { createAiEngine, type AiWorkerRequest, type AiWorkerResponse } from '../../src/ai/client';
import { AiError } from '../../src/ai/errors';

type Req = { n: number };
type Res = { doubled: number };

class FakeWorker {
  posted: { message: AiWorkerRequest<Req>; transfer?: Transferable[] }[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent<AiWorkerResponse<Res>>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(message: AiWorkerRequest<Req>, transfer?: Transferable[]) {
    this.posted.push({ message, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  reply(m: AiWorkerResponse<Res>) {
    this.onmessage?.({ data: m } as MessageEvent<AiWorkerResponse<Res>>);
  }
  crash() {
    this.onerror?.({} as ErrorEvent);
  }
  idAt(i: number) {
    return this.posted[i]!.message.id;
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const engine = createAiEngine<Req, Res>(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w as unknown as Worker;
  });
  return { engine, workers };
}
const settle = async <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const reason = (r: { ok: boolean; e?: unknown }) => (r.ok ? 'resolved' : (r.e as AiError).reason);

describe('ai client', () => {
  it('runs jobs one at a time, in order, passing the transfer list, and resolves each', async () => {
    const { engine, workers } = setup();
    const buf = new ArrayBuffer(8);
    const a = engine.run({ n: 1 }, [buf]);
    const b = engine.run({ n: 2 });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toHaveLength(1);
    expect(workers[0]!.posted[0]).toMatchObject({ message: { kind: 'job', req: { n: 1 } }, transfer: [buf] });
    workers[0]!.reply({ kind: 'done', id: workers[0]!.idAt(0), result: { doubled: 2 } });
    expect(await a).toEqual({ doubled: 2 });
    expect(workers[0]!.posted).toHaveLength(2);
    expect(workers[0]!.posted[1]!.message.req).toEqual({ n: 2 });
    workers[0]!.reply({ kind: 'done', id: workers[0]!.idAt(1), result: { doubled: 4 } });
    expect(await b).toEqual({ doubled: 4 });
  });

  it('routes progress of the running job to its own callback only', async () => {
    const { engine, workers } = setup();
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const a = engine.run({ n: 1 }, [], (p) => seenA.push(p));
    void engine.run({ n: 2 }, [], (p) => seenB.push(p));
    const id = workers[0]!.idAt(0);
    workers[0]!.reply({ kind: 'progress', id, stage: 'download', done: 5, total: 10 });
    workers[0]!.reply({ kind: 'progress', id, stage: 'work', done: 1, total: 2 });
    workers[0]!.reply({ kind: 'progress', id: 'other', stage: 'work', done: 1, total: 2 });
    workers[0]!.reply({ kind: 'done', id, result: { doubled: 2 } });
    await a;
    expect(seenA).toEqual([
      { stage: 'download', done: 5, total: 10 },
      { stage: 'work', done: 1, total: 2 },
    ]);
    expect(seenB).toEqual([]);
  });

  it('a progress callback that throws never stops the queue', async () => {
    const { engine, workers } = setup();
    const a = engine.run({ n: 1 }, [], () => {
      throw new Error('listener bug');
    });
    const err = console.error;
    console.error = () => {};
    try {
      workers[0]!.reply({ kind: 'progress', id: workers[0]!.idAt(0), stage: 'work', done: 1, total: 2 });
    } finally {
      console.error = err;
    }
    workers[0]!.reply({ kind: 'done', id: workers[0]!.idAt(0), result: { doubled: 2 } });
    expect(await a).toEqual({ doubled: 2 });
  });

  it('rejects with an AiError carrying the worker reason and keeps the worker', async () => {
    const { engine, workers } = setup();
    const a = settle(engine.run({ n: 1 }));
    workers[0]!.reply({ kind: 'failed', id: workers[0]!.idAt(0), reason: 'too-long' });
    const r = await a;
    expect(r.ok === false && r.e).toBeInstanceOf(AiError);
    expect(reason(r)).toBe('too-long');
    expect(workers[0]!.terminated).toBe(false);
    const b = engine.run({ n: 2 });
    expect(workers).toHaveLength(1);
    workers[0]!.reply({ kind: 'done', id: workers[0]!.idAt(1), result: { doubled: 4 } });
    expect(await b).toEqual({ doubled: 4 });
  });

  it('a crash before the first message is network, and the next job gets a fresh worker', async () => {
    const { engine, workers } = setup();
    const a = settle(engine.run({ n: 1 }));
    const b = engine.run({ n: 2 });
    workers[0]!.crash();
    expect(reason(await a)).toBe('network');
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ kind: 'done', id: workers[1]!.idAt(0), result: { doubled: 4 } });
    expect(await b).toEqual({ doubled: 4 });
  });

  it('a crash after the worker has spoken is corrupt, with a fresh worker afterwards', async () => {
    const { engine, workers } = setup();
    const a = settle(engine.run({ n: 1 }));
    workers[0]!.reply({ kind: 'progress', id: workers[0]!.idAt(0), stage: 'work', done: 0, total: 1 });
    workers[0]!.crash();
    expect(reason(await a)).toBe('corrupt');
    const c = engine.run({ n: 3 });
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ kind: 'done', id: workers[1]!.idAt(0), result: { doubled: 6 } });
    expect(await c).toEqual({ doubled: 6 });
  });

  it('ignores a stale crash from a replaced worker and replies for other jobs', async () => {
    const { engine, workers } = setup();
    const a = settle(engine.run({ n: 1 }));
    workers[0]!.crash();
    await a;
    const b = engine.run({ n: 2 });
    workers[0]!.crash(); // the old worker: must not fail job 2
    workers[0]!.reply({ kind: 'done', id: workers[1]!.idAt(0), result: { doubled: 99 } }); // nor answer it
    workers[1]!.reply({ kind: 'done', id: 'nope', result: { doubled: 9 } });
    workers[1]!.reply({ kind: 'done', id: workers[1]!.idAt(0), result: { doubled: 4 } });
    expect(await b).toEqual({ doubled: 4 });
  });

  it('a network failure reply retires the worker, so a retry loads afresh', async () => {
    const { engine, workers } = setup();
    const a = settle(engine.run({ n: 1 }));
    workers[0]!.reply({ kind: 'failed', id: workers[0]!.idAt(0), reason: 'network' });
    expect(reason(await a)).toBe('network');
    expect(workers[0]!.terminated).toBe(true);
    const b = engine.run({ n: 2 });
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ kind: 'done', id: workers[1]!.idAt(0), result: { doubled: 4 } });
    expect(await b).toEqual({ doubled: 4 });
  });

  it('a worker that cannot be created fails the job as network and the queue moves on', async () => {
    let calls = 0;
    const workers: FakeWorker[] = [];
    const engine = createAiEngine<Req, Res>(() => {
      if (calls++ === 0) throw new Error('blocked by CSP');
      const w = new FakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    });
    const err = console.error;
    console.error = () => {};
    try {
      const a = settle(engine.run({ n: 1 }));
      const b = engine.run({ n: 2 });
      expect(reason(await a)).toBe('network');
      workers[0]!.reply({ kind: 'done', id: workers[0]!.idAt(0), result: { doubled: 4 } });
      expect(await b).toEqual({ doubled: 4 });
    } finally {
      console.error = err;
    }
  });

  it('an abort signal cancels a running job: the worker is terminated and the next job gets a fresh one', async () => {
    const { engine, workers } = setup();
    const ctrl = new AbortController();
    const a = settle(engine.run({ n: 1 }, [], undefined, ctrl.signal));
    const b = engine.run({ n: 2 });
    ctrl.abort();
    expect(reason(await a)).toBe('cancelled');
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ kind: 'done', id: workers[1]!.idAt(0), result: { doubled: 4 } });
    expect(await b).toEqual({ doubled: 4 });
  });

  it('an abort signal on a queued job removes it without touching the running one', async () => {
    const { engine, workers } = setup();
    const ctrl = new AbortController();
    const a = engine.run({ n: 1 });
    const b = settle(engine.run({ n: 2 }, [], undefined, ctrl.signal));
    ctrl.abort();
    expect(reason(await b)).toBe('cancelled');
    workers[0]!.reply({ kind: 'done', id: workers[0]!.idAt(0), result: { doubled: 2 } });
    expect(await a).toEqual({ doubled: 2 });
    expect(workers[0]!.posted).toHaveLength(1); // job 2 never reached the worker
    expect(workers[0]!.terminated).toBe(false);
  });

  it('an already-aborted signal rejects at once without posting', async () => {
    const { engine, workers } = setup();
    const ctrl = new AbortController();
    ctrl.abort();
    expect(reason(await settle(engine.run({ n: 1 }, [], undefined, ctrl.signal)))).toBe('cancelled');
    expect(workers).toHaveLength(0);
  });

  for (const why of ['device', 'corrupt'] as const) {
    it(`a ${why} reply retires the worker, so the next job gets a fresh one`, async () => {
      const { engine, workers } = setup();
      const a = settle(engine.run({ n: 1 }));
      workers[0]!.reply({ kind: 'failed', id: workers[0]!.idAt(0), reason: why });
      expect(reason(await a)).toBe(why);
      expect(workers[0]!.terminated).toBe(true);
      const b = engine.run({ n: 2 });
      expect(workers).toHaveLength(2);
      workers[1]!.reply({ kind: 'done', id: workers[1]!.idAt(0), result: { doubled: 4 } });
      expect(await b).toEqual({ doubled: 4 });
    });
  }

  it('carries badModel and detectedType from the worker onto the AiError', async () => {
    const { engine, workers } = setup();
    const a = settle(engine.run({ n: 1 }));
    workers[0]!.reply({ kind: 'failed', id: workers[0]!.idAt(0), reason: 'network', badModel: true });
    const r = await a;
    expect(r.ok === false && (r.e as AiError).badModel).toBe(true);
    const b = settle(engine.run({ n: 2 }));
    workers[1]!.reply({ kind: 'failed', id: workers[1]!.idAt(0), reason: 'wrong-type', detectedType: 'heic' });
    const r2 = await b;
    expect(r2.ok === false && (r2.e as AiError).detectedType).toBe('heic');
    expect(r2.ok === false && (r2.e as AiError).badModel).toBe(false);
  });
});
