import { afterEach, describe, expect, it, vi } from 'vitest';
import { detect } from '../../src/ai/capability';

type Nav = Record<string, unknown>;
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

function stub(nav: Nav, globals: Record<string, unknown> = {}) {
  vi.stubGlobal('navigator', { userAgent: DESKTOP_UA, maxTouchPoints: 0, ...nav });
  vi.stubGlobal('VideoDecoder', undefined);
  vi.stubGlobal('VideoEncoder', undefined);
  for (const [k, v] of Object.entries(globals)) vi.stubGlobal(k, v);
}
const encoder = (supported: boolean | 'throw') => ({
  isConfigSupported: async () => {
    if (supported === 'throw') throw new TypeError('bad config');
    return { supported };
  },
});
afterEach(() => vi.unstubAllGlobals());

describe('detect', () => {
  it('a bare desktop browser: no WebGPU, no memory hint, not mobile, not cellular, no WebCodecs', async () => {
    stub({});
    expect(await detect()).toEqual({
      webgpu: false,
      webgpuF16: false,
      mobile: false,
      cellular: false,
      webcodecs: { decode: false, h264Encode: false },
    });
  });

  it('navigator.gpu missing → webgpu false; present with an adapter → true; no adapter → false', async () => {
    stub({});
    expect((await detect()).webgpu).toBe(false);
    stub({ gpu: { requestAdapter: async () => ({}) } });
    expect((await detect()).webgpu).toBe(true);
    stub({ gpu: { requestAdapter: async () => null } });
    expect((await detect()).webgpu).toBe(false);
    stub({ gpu: { requestAdapter: async () => Promise.reject(new Error('blocked')) } });
    expect((await detect()).webgpu).toBe(false);
  });

  it('a software (fallback) adapter is no WebGPU; shader-f16 is reported', async () => {
    stub({ gpu: { requestAdapter: async () => ({ info: { isFallbackAdapter: true }, features: new Set(['shader-f16']) }) } });
    expect(await detect()).toMatchObject({ webgpu: false, webgpuF16: false });
    stub({ gpu: { requestAdapter: async () => ({ isFallbackAdapter: true }) } });
    expect((await detect()).webgpu).toBe(false);
    stub({ gpu: { requestAdapter: async () => ({ info: { isFallbackAdapter: false }, features: new Set(['shader-f16']) }) } });
    expect(await detect()).toMatchObject({ webgpu: true, webgpuF16: true });
    stub({ gpu: { requestAdapter: async () => ({ features: new Set() }) } });
    expect(await detect()).toMatchObject({ webgpu: true, webgpuF16: false });
  });

  it('reports navigator.deviceMemory as deviceMemoryGB', async () => {
    stub({ deviceMemory: 2 });
    expect((await detect()).deviceMemoryGB).toBe(2);
  });

  it('connection.type cellular → cellular true; wifi or no connection → false', async () => {
    stub({ connection: { type: 'cellular' } });
    expect((await detect()).cellular).toBe(true);
    stub({ connection: { type: 'wifi' } });
    expect((await detect()).cellular).toBe(false);
  });

  it('mobile from userAgentData, else the user agent, and iPadOS posing as a Mac', async () => {
    stub({ userAgentData: { mobile: true } });
    expect((await detect()).mobile).toBe(true);
    stub({ userAgent: PHONE_UA });
    expect((await detect()).mobile).toBe(true);
    stub({ maxTouchPoints: 5 }); // iPad: Mac user agent, but a touch screen
    expect((await detect()).mobile).toBe(true);
    stub({ userAgentData: { mobile: false } });
    expect((await detect()).mobile).toBe(false);
  });

  it('VideoEncoder.isConfigSupported false → h264Encode false; true → true; throwing → false', async () => {
    stub({}, { VideoDecoder: function VideoDecoder() {}, VideoEncoder: encoder(false) });
    expect((await detect()).webcodecs).toEqual({ decode: true, h264Encode: false });
    stub({}, { VideoDecoder: function VideoDecoder() {}, VideoEncoder: encoder(true) });
    expect((await detect()).webcodecs).toEqual({ decode: true, h264Encode: true });
    stub({}, { VideoEncoder: encoder('throw') });
    expect((await detect()).webcodecs.h264Encode).toBe(false);
  });

  it('an adapter request that hangs counts as no WebGPU after 1.5 s', async () => {
    vi.useFakeTimers();
    try {
      stub({ gpu: { requestAdapter: () => new Promise(() => {}) } });
      const caps = detect();
      await vi.advanceTimersByTimeAsync(1499);
      let settled = false;
      void caps.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await caps).webgpu).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
