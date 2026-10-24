import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiError } from '../../src/ai/errors';
import { MODELS, modelUrl } from '../../src/ai/config';
import { evictModel, isCached, loadModel } from '../../src/ai/loader';

// An in-memory Cache Storage, keyed by URL, enough for the loader.
class MemoryCache {
  entries = new Map<string, Response>();
  async match(url: string) {
    return this.entries.get(url)?.clone();
  }
  async put(url: string, res: Response) {
    // Like the real Cache API: the body is consumed in full before the entry exists; a body that errors stores nothing.
    const body = await res.arrayBuffer();
    this.entries.set(url, new Response(body, { headers: res.headers }));
  }
  async delete(req: string | Request) {
    return this.entries.delete(typeof req === 'string' ? req : req.url);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}
class MemoryCacheStorage {
  stores = new Map<string, MemoryCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new MemoryCache());
    return this.stores.get(name)!;
  }
}

const URL_A = 'https://models.test/bg/model.onnx';
const bytesOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

/** A response that streams `body` in `chunks` pieces. */
function streamed(body: Uint8Array, { chunks = 4, length = true } = {}) {
  const size = Math.ceil(body.length / chunks);
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i * size >= body.length) return c.close();
      c.enqueue(body.slice(i * size, ++i * size));
    },
  });
  return new Response(stream, { headers: length ? { 'Content-Length': String(body.length) } : {} });
}

let storage: MemoryCacheStorage;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storage = new MemoryCacheStorage();
  fetchMock = vi.fn();
  vi.stubGlobal('caches', storage);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const reasonOf = async (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof AiError ? e.reason : `not an AiError: ${String(e)}`),
  );

describe('loadModel', () => {
  it('streams the body, reports progress up to the total, and returns the bytes', async () => {
    const body = bytesOf(1000);
    fetchMock.mockResolvedValue(streamed(body));
    const seen: [number, number][] = [];
    const buf = await loadModel(URL_A, { bytes: 999_999, onProgress: (d, t) => seen.push([d, t]) });
    expect(new Uint8Array(buf)).toEqual(body);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.at(-1)).toEqual([1000, 1000]); // Content-Length wins over the configured size
    for (let i = 1; i < seen.length; i++) expect(seen[i]![0]).toBeGreaterThanOrEqual(seen[i - 1]![0]);
  });

  it('falls back to the configured size when there is no Content-Length', async () => {
    fetchMock.mockResolvedValue(streamed(bytesOf(100), { length: false }));
    const seen: [number, number][] = [];
    await loadModel(URL_A, { bytes: 100, onProgress: (d, t) => seen.push([d, t]) });
    expect(seen.every(([, t]) => t === 100)).toBe(true);
    expect(seen.at(-1)).toEqual([100, 100]);
  });

  it('serves a second load from the cache with no fetch', async () => {
    const body = bytesOf(300);
    fetchMock.mockResolvedValue(streamed(body));
    expect(await isCached(URL_A)).toBe(false);
    await loadModel(URL_A, { bytes: 300 });
    expect(await isCached(URL_A)).toBe(true);
    fetchMock.mockClear();
    const seen: [number, number][] = [];
    const again = await loadModel(URL_A, { bytes: 300, onProgress: (d, t) => seen.push([d, t]) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(new Uint8Array(again)).toEqual(body);
    expect(seen.at(-1)).toEqual([300, 300]);
  });

  it('a cached model loads while offline (Review Focus 2)', async () => {
    fetchMock.mockResolvedValue(streamed(bytesOf(50)));
    await loadModel(URL_A, { bytes: 50 });
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch')); // offline
    const buf = await loadModel(URL_A, { bytes: 50 });
    expect(buf.byteLength).toBe(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('abort mid-download rejects as cancelled and caches nothing; a later load starts afresh (Review Focus 1)', async () => {
    // A real fetch errors its body stream when the signal aborts. This one sends 100 bytes, then stalls.
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
        pull(c) {
          if (sent) return new Promise(() => {});
          sent = true;
          c.enqueue(bytesOf(100));
        },
      });
      return new Response(body, { headers: { 'Content-Length': '400' } });
    });
    const ctrl = new AbortController();
    const p = loadModel(URL_A, {
      bytes: 400,
      signal: ctrl.signal,
      onProgress: (done) => {
        if (done > 0) ctrl.abort();
      },
    });
    expect(await reasonOf(p)).toBe('cancelled');
    expect(await isCached(URL_A)).toBe(false);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(streamed(bytesOf(400)));
    const buf = await loadModel(URL_A, { bytes: 400 });
    expect(buf.byteLength).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted signal is cancelled without a fetch', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await reasonOf(loadModel(URL_A, { bytes: 1, signal: ctrl.signal }))).toBe('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a fetch aborted before the response is cancelled', async () => {
    fetchMock.mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    const ctrl = new AbortController();
    const p = loadModel(URL_A, { bytes: 1, signal: ctrl.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled()); // the request is out, no response yet
    ctrl.abort();
    expect(await reasonOf(p)).toBe('cancelled');
  });

  it('HTTP 404 (model unavailable) is reported as network, and nothing is cached', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
    expect(await reasonOf(loadModel(URL_A, { bytes: 1 }))).toBe('network');
    expect(await isCached(URL_A)).toBe(false);
  });

  it('a network failure is network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await reasonOf(loadModel(URL_A, { bytes: 1 }))).toBe('network');
  });

  it('a body that breaks off mid-stream is network, and nothing is cached', async () => {
    let sent = false;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(c) {
            if (sent) return c.error(new TypeError('network error'));
            sent = true;
            c.enqueue(bytesOf(10));
          },
        }),
      ),
    );
    expect(await reasonOf(loadModel(URL_A, { bytes: 100 }))).toBe('network');
    expect(await isCached(URL_A)).toBe(false);
  });

  it('works without Cache Storage (still downloads; isCached is false)', async () => {
    vi.stubGlobal('caches', undefined);
    fetchMock.mockResolvedValue(streamed(bytesOf(20)));
    expect((await loadModel(URL_A, { bytes: 20 })).byteLength).toBe(20);
    expect(await isCached(URL_A)).toBe(false);
  });

  it('a failing cache write (quota) still returns the model', async () => {
    const cache = await storage.open('models-v1');
    cache.put = async () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    fetchMock.mockResolvedValue(streamed(bytesOf(20)));
    expect((await loadModel(URL_A, { bytes: 20 })).byteLength).toBe(20);
  });

  it('asks for the model with no credentials and no referrer', async () => {
    fetchMock.mockResolvedValue(streamed(bytesOf(10)));
    await loadModel(URL_A, { bytes: 10 });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('a body shorter than its Content-Length is network, and is not cached', async () => {
    const body = bytesOf(50);
    fetchMock.mockResolvedValue(
      new Response(new ReadableStream({ start: (c) => (c.enqueue(body), c.close()) }), { headers: { 'Content-Length': '100' } }),
    );
    expect(await reasonOf(loadModel(URL_A, { bytes: 100 }))).toBe('network');
    expect(await isCached(URL_A)).toBe(false);
    expect((await storage.open('models-v1')).entries.size).toBe(0);
  });

  it('a compressed body is not held to its Content-Length (which counts compressed bytes)', async () => {
    const body = bytesOf(80);
    fetchMock.mockResolvedValue(
      new Response(new ReadableStream({ start: (c) => (c.enqueue(body), c.close()) }), {
        headers: { 'Content-Length': '30', 'Content-Encoding': 'gzip' },
      }),
    );
    expect((await loadModel(URL_A, { bytes: 80 })).byteLength).toBe(80);
    expect(await isCached(URL_A)).toBe(true);
  });

  it('records the length on the entry, also without a Content-Length', async () => {
    fetchMock.mockResolvedValue(streamed(bytesOf(3_000_000), { length: false, chunks: 7 })); // grows past 1 MB
    expect((await loadModel(URL_A, { bytes: 10 })).byteLength).toBe(3_000_000);
    const entry = (await storage.open('models-v1')).entries.get(URL_A)!;
    expect(entry.headers.get('X-Model-Bytes')).toBe('3000000');
  });

  it('a truncated cache entry is dropped and downloaded again', async () => {
    const cache = await storage.open('models-v1');
    cache.entries.set(URL_A, new Response(bytesOf(50), { headers: { 'X-Model-Bytes': '100' } }));
    expect(await isCached(URL_A)).toBe(true); // it claims to be there…
    fetchMock.mockResolvedValue(streamed(bytesOf(100)));
    const buf = await loadModel(URL_A, { bytes: 100 });
    expect(buf.byteLength).toBe(100); // …but the length check catches it
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await cache.match(URL_A))!.headers.get('X-Model-Bytes')).toBe('100');
    expect((await (await cache.match(URL_A))!.arrayBuffer()).byteLength).toBe(100);
  });

  it('an entry without a recorded length is not trusted: not cached, and downloaded again', async () => {
    const cache = await storage.open('models-v1');
    cache.entries.set(URL_A, new Response(bytesOf(100)));
    expect(await isCached(URL_A)).toBe(false);
    fetchMock.mockResolvedValue(streamed(bytesOf(100)));
    await loadModel(URL_A, { bytes: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await isCached(URL_A)).toBe(true);
  });

  it('evictModel drops a cached model, so the next load downloads it', async () => {
    fetchMock.mockResolvedValue(streamed(bytesOf(10)));
    await loadModel(URL_A, { bytes: 10 });
    await evictModel(URL_A);
    expect(await isCached(URL_A)).toBe(false);
    fetchMock.mockResolvedValue(streamed(bytesOf(10)));
    await loadModel(URL_A, { bytes: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a successful load prunes entries that belong to no current model', async () => {
    const cache = await storage.open('models-v1');
    const stale = 'https://models.test/old/u2net-v0.onnx';
    const current = modelUrl('bg');
    const whisperFile = `${modelUrl('whisper')}/config.json`; // a file under a directory model is kept
    for (const u of [stale, current, whisperFile]) cache.entries.set(u, new Response(bytesOf(1), { headers: { 'X-Model-Bytes': '1' } }));
    fetchMock.mockResolvedValue(streamed(bytesOf(10)));
    await loadModel(URL_A, { bytes: 10 });
    expect([...cache.entries.keys()].sort()).toEqual([URL_A, current, whisperFile].sort());
    expect(MODELS.bg.path).toBeTruthy();
  });
});
