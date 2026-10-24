import { MODELS, modelFiles, modelUrl, type ModelKey } from './config';
import { AiError } from './errors';

// Models download once and live in Cache Storage. The cache write streams alongside the download (a clone of the
// response), so the model is held in memory once, not three times. An entry records its length (X-Model-Bytes);
// a download that ends short, is cancelled or breaks off leaves no entry, and an entry whose length doesn't match
// is dropped and downloaded again. Without Cache Storage the model still downloads.

const CACHE_NAME = 'models-v1';
const LENGTH_HEADER = 'X-Model-Bytes';

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' || !caches ? null : await caches.open(CACHE_NAME);
  } catch {
    return null; // storage blocked (some private modes)
  }
}

/** A cached response whose length is recorded (entries without the header are not ours to trust). */
async function cached(url: string): Promise<Response | undefined> {
  const cache = await openCache();
  try {
    const hit = (await cache?.match(url)) ?? undefined;
    return hit?.headers.get(LENGTH_HEADER) ? hit : undefined;
  } catch {
    return undefined;
  }
}

/** Is this model already in the cache (so it needs no download, and no consent)? */
export async function isCached(url: string): Promise<boolean> {
  return (await cached(url)) !== undefined;
}

/** Drop a cached model, for example one whose bytes failed to parse, so the next load downloads it afresh. */
export async function evictModel(url: string): Promise<void> {
  try {
    await (await openCache())?.delete(url);
  } catch {
    // nothing to drop, or storage blocked
  }
}

/** Delete entries that belong to no current model (older versions), keeping `keep`. */
async function prune(cache: Cache, keep: string): Promise<void> {
  const current = (Object.keys(MODELS) as ModelKey[]).map(modelUrl);
  const wanted = (url: string) => url === keep || current.some((u) => url === u || url.startsWith(`${u}/`));
  try {
    for (const req of await cache.keys()) if (!wanted(req.url)) await cache.delete(req);
  } catch {
    // best effort
  }
}

export interface LoadOptions {
  /** The expected size, used for progress when the response has no Content-Length. */
  bytes: number;
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
}

/** The model's bytes, from the cache or else downloaded (and then cached). Rejects with AiError network | cancelled. */
export async function loadModel(url: string, { bytes, onProgress, signal }: LoadOptions): Promise<ArrayBuffer> {
  const cancelled = () => new AiError('cancelled');
  if (signal?.aborted) throw cancelled();
  const cache = await openCache();

  const hit = await cached(url);
  if (hit) {
    try {
      const buf = await hit.arrayBuffer();
      if (buf.byteLength === Number(hit.headers.get(LENGTH_HEADER))) {
        onProgress?.(buf.byteLength, buf.byteLength);
        if (cache) await prune(cache, url);
        return buf;
      }
    } catch {
      // unreadable: download it again
    }
    await evictModel(url); // truncated or mislabelled
  }

  if (signal?.aborted) throw cancelled();
  let res: Response;
  try {
    // GET only, no credentials, no referrer: the model host learns nothing about the user, the page or the file.
    res = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw signal?.aborted ? cancelled() : new AiError('network');
  }
  // A missing model (404) or a server error: to the user it is a download that failed.
  if (!res.ok || !res.body) throw new AiError('network');

  const declared = Number(res.headers.get('content-length')) || 0;
  // With a compressed transfer, Content-Length counts the compressed bytes: it can't check what we receive.
  const exact = declared > 0 && !res.headers.get('content-encoding');
  const total = declared || bytes;

  // Exact length known up front: write the cache from a clone, in parallel. Otherwise write it after the read.
  let put: Promise<unknown> | null = null;
  if (cache && exact) {
    const copy = res.clone();
    const headers = { 'Content-Type': 'application/octet-stream', [LENGTH_HEADER]: String(declared) };
    put = cache.put(url, new Response(copy.body, { headers }));
    put.catch(() => {}); // settled below
  }

  let buf = new Uint8Array(exact ? declared : Math.max(total, 1 << 20));
  let done = 0;
  const reader = res.body.getReader();
  try {
    onProgress?.(0, total);
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      if (signal?.aborted) throw cancelled();
      if (done + value.byteLength > buf.byteLength) {
        const grown = new Uint8Array(Math.max(buf.byteLength * 2, done + value.byteLength));
        grown.set(buf.subarray(0, done));
        buf = grown;
      }
      buf.set(value, done);
      done += value.byteLength;
      onProgress?.(done, Math.max(total, done));
    }
    if (exact && done !== declared) throw new AiError('network'); // the body ended short (or long)
  } catch (err) {
    void reader.cancel().catch(() => {});
    if (put) await settleAndDrop(put, url);
    if (signal?.aborted || (err instanceof AiError && err.reason === 'cancelled')) throw cancelled();
    throw new AiError('network'); // the connection broke off mid-download
  }

  const out = done === buf.byteLength ? buf : buf.slice(0, done);
  if (cache) {
    try {
      if (put) await put;
      // `new Response(bytes)` copies them, so the caller may transfer the returned buffer to a worker.
      else await cache.put(url, new Response(out, { headers: { 'Content-Type': 'application/octet-stream', [LENGTH_HEADER]: String(done) } }));
      await prune(cache, url);
    } catch {
      await evictModel(url); // quota or storage blocked: the model works, it just downloads again next time
    }
  }
  return out.buffer;
}

/** Wait for a cache write that can no longer be trusted, then make sure it left nothing behind. */
async function settleAndDrop(put: Promise<unknown>, url: string): Promise<void> {
  await put.catch(() => {});
  await evictModel(url);
}

/**
 * Every file of these models, in order, through loadModel (Cache Storage, progress). Their download is reported as
 * one: done and total count only the files not yet cached, as the page counts them. Returns each file's bytes by URL.
 */
export async function loadModelFiles(
  keys: ModelKey[],
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Map<string, ArrayBuffer>> {
  const files = keys.flatMap(modelFiles);
  const cached = await Promise.all(files.map((f) => isCached(f.url)));
  const total = files.reduce((n, f, i) => n + (cached[i] ? 0 : f.bytes), 0);
  const out = new Map<string, ArrayBuffer>();
  let before = 0;
  for (const [i, f] of files.entries()) {
    const bytes = await loadModel(f.url, {
      bytes: f.bytes,
      ...(signal ? { signal } : {}),
      onProgress: (done) => {
        if (!cached[i]) onProgress(Math.min(total, before + done), total);
      },
    });
    if (!cached[i]) before += f.bytes;
    out.set(f.url, bytes);
  }
  return out;
}
