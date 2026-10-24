import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createSession, isOutOfMemory, looksLikeOnnx, runtimeMayBeDamaged, sessionFailure } from '../../src/ai/ort/session';
import { MODELS } from '../../src/ai/config';
import { AiError } from '../../src/ai/errors';

const require = createRequire(import.meta.url);

/** Bytes that pass the ONNX header check. */
const onnxish = () => {
  const b = new Uint8Array(4096);
  b[0] = 0x08;
  return b.buffer;
};
const failingOrt = (err: unknown) => ({
  InferenceSession: {
    create: async () => {
      throw err;
    },
  },
}) as unknown as Parameters<typeof createSession>[0];

const outcome = async (err: unknown) => {
  const e = await createSession(failingOrt(err), onnxish()).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(AiError);
  return { reason: (e as AiError).reason, badModel: (e as AiError).badModel };
};

describe('createSession error mapping', () => {
  it('a model onnxruntime could not parse is a bad model (dropped and downloaded again)', async () => {
    // The real message, from onnxruntime-web 1.30 given damaged bytes.
    const parse = new Error("Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.");
    expect(await outcome(parse)).toEqual({ reason: 'network', badModel: true });
    expect(await outcome(new Error("Can't create a session. ERROR_CODE: 10, ERROR_MESSAGE: invalid graph"))).toEqual({ reason: 'network', badModel: true });
  });

  it('no available backend is the device, not the model', async () => {
    const e = new Error('no available backend found. ERR: [wasm] RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): ...)');
    expect(await outcome(e)).toEqual({ reason: 'device', badModel: false });
  });

  it('a WebAssembly module that will not compile or instantiate is the device', async () => {
    expect(await outcome(new WebAssembly.CompileError('WebAssembly.Module(): expected magic word'))).toEqual({ reason: 'device', badModel: false });
    expect(await outcome(new WebAssembly.RuntimeError('unreachable'))).toEqual({ reason: 'device', badModel: false });
  });

  it('running out of memory is the device', async () => {
    expect(await outcome(new RangeError('Array buffer allocation failed'))).toEqual({ reason: 'device', badModel: false });
    expect(await outcome(new Error("Can't create a session. ERROR_CODE: 6, ERROR_MESSAGE: bad_alloc"))).toEqual({ reason: 'device', badModel: false });
  });

  it('bytes that are not ONNX at all are a bad model, without asking the runtime', async () => {
    let asked = false;
    const ort = { InferenceSession: { create: async () => ((asked = true), {}) } } as unknown as Parameters<typeof createSession>[0];
    const e = await createSession(ort, new TextEncoder().encode('<html>'.repeat(400)).buffer).catch((x: unknown) => x);
    expect((e as AiError).badModel).toBe(true);
    expect(asked).toBe(false);
  });

  it('an AiError passes through unchanged', () => {
    const e = new AiError('cancelled');
    expect(sessionFailure(e)).toBe(e);
  });
});

describe('looksLikeOnnx', () => {
  it('accepts the real u2netp header shape and rejects zeros', () => {
    expect(looksLikeOnnx(onnxish())).toBe(true);
    expect(looksLikeOnnx(new ArrayBuffer(4096))).toBe(false);
  });
});

describe('the WebAssembly runtime entry', () => {
  it('records the size of the onnxruntime-web .wasm this build ships (shown before its first download)', () => {
    const file = require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm');
    expect(MODELS.ortWasm.bytes).toBe(statSync(file).size);
    expect(MODELS.ortWasm.sameOrigin).toBe(true);
    expect(readFileSync(file).subarray(0, 4)).toEqual(Buffer.from([0, 0x61, 0x73, 0x6d]));
  });
});

describe('runtimeMayBeDamaged: whether a failed start drops the cached runtime .wasm', () => {
  it('a runtime that would not start (not memory) may be a damaged cached .wasm: dropped', async () => {
    const raw = new Error('no available backend found. ERR: [wasm] RuntimeError: Aborted(CompileError)');
    const e = (await createSession(failingOrt(raw), onnxish()).catch((x: unknown) => x)) as AiError;
    expect(e.reason).toBe('device');
    expect(runtimeMayBeDamaged(e)).toBe(true);
  });

  it('memory running out is the device, not the file: the cached .wasm is kept', async () => {
    for (const raw of [
      new RangeError('Array buffer allocation failed'),
      new WebAssembly.RuntimeError('Aborted(Cannot enlarge memory arrays to size 2147483648 bytes (OOM).)'),
      new Error('session failed', { cause: new RangeError('WebAssembly.Memory(): could not allocate memory') }),
    ]) {
      const e = sessionFailure(raw);
      expect(e.reason, raw.message).toBe('device');
      expect(isOutOfMemory(e), raw.message).toBe(true);
      expect(runtimeMayBeDamaged(e), raw.message).toBe(false);
    }
  });

  it('a bad model or any other reason never drops the runtime', () => {
    expect(runtimeMayBeDamaged(new AiError('network', { badModel: true }))).toBe(false);
    expect(runtimeMayBeDamaged(new AiError('corrupt'))).toBe(false);
  });
});
