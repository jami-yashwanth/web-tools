import { AiError } from '../errors';

// Transcribe audio's input: the file's sound as 16 kHz mono samples, which is what Whisper reads. Decoding is the
// browser's own (OfflineAudioContext.decodeAudioData: MP3, M4A, WAV, OGG, and the sound of MP4, MOV and WebM where
// the browser reads them), on the main thread, where it is available; the samples are then transferred to the
// worker. The sample helpers are pure.

/** Whisper's sample rate. */
export const SAMPLE_RATE = 16_000;

/** Audio up to 30 minutes for now (spec §4). */
export const MAX_SECONDS = 30 * 60;

/** Files up to 300 MB for now: the whole file is read into memory to decode it (spec ruling, Task 7). */
export const MAX_BYTES = 300_000_000;

/** Below this level (about -50 dBFS, RMS over 20 ms) a stretch of audio counts as silent. */
const SILENT_RMS = 0.003;

/** The channels averaged into one. */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const n = channels[0]!.length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i]! += ch[i]!;
  for (let i = 0; i < n; i++) out[i]! /= channels.length;
  return out;
}

/**
 * The samples at another rate, keeping the duration (to the nearest sample). Going down, each output sample is the
 * mean of the input over its own span, centred on it (a box filter, which damps what the new rate can't hold
 * instead of folding it back); going up, input samples are interpolated linearly.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const n = input.length;
  const out = new Float32Array(Math.round((n * to) / from));
  if (!n) return out;
  const r = from / to; // input samples per output sample
  if (r < 1) {
    for (let j = 0; j < out.length; j++) {
      const x = Math.min(n - 1, j * r);
      const i = Math.floor(x);
      const f = x - i;
      out[j] = input[i]! * (1 - f) + input[Math.min(n - 1, i + 1)]! * f;
    }
    return out;
  }
  // Sample i stands for the span [i - 0.5, i + 0.5). sum[k] is the total of the first k samples.
  const sum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i]! + input[i]!;
  /** The integral of the samples from -0.5 to x. */
  const area = (x: number): number => {
    const y = Math.min(n, Math.max(0, x + 0.5));
    const k = Math.min(n - 1, Math.floor(y));
    return sum[k]! + (y - k) * input[k]!;
  };
  for (let j = 0; j < out.length; j++) {
    const lo = Math.max(-0.5, j * r - r / 2);
    const hi = Math.min(n - 0.5, j * r + r / 2);
    out[j] = hi > lo ? (area(hi) - area(lo)) / (hi - lo) : input[Math.min(n - 1, Math.round(j * r))]!;
  }
  return out;
}

/** Is there anything louder than silence or a faint hiss, anywhere in these samples? */
export function hasSound(samples: Float32Array, rate: number): boolean {
  const frame = Math.max(1, Math.round(rate * 0.02));
  const limit = SILENT_RMS * SILENT_RMS * frame;
  for (let start = 0; start < samples.length; start += frame) {
    const end = Math.min(samples.length, start + frame);
    let energy = 0;
    for (let i = start; i < end; i++) energy += samples[i]! * samples[i]!;
    if (energy > limit * ((end - start) / frame)) return true;
  }
  return false;
}

/**
 * The file's length in seconds from its own header, read by a media element without decoding it, when the browser
 * can tell (so a long file is turned away before it is decoded into memory). Undefined when it can't.
 */
export function mediaDuration(file: Blob, timeoutMs = 5000): Promise<number | undefined> {
  return new Promise((resolve) => {
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.muted = true;
    const url = URL.createObjectURL(file);
    const done = (seconds?: number) => {
      clearTimeout(timer);
      el.onloadedmetadata = el.onerror = null;
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    const timer = setTimeout(() => done(), timeoutMs);
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : undefined);
    el.onerror = () => done();
    el.src = url;
  });
}

/**
 * The file's sound as 16 kHz mono. Rejects with AiError too-large over MAX_BYTES (before reading it), corrupt when
 * the browser can't decode it, and cancelled once `signal` aborts (the decode itself can't be stopped: its result
 * is dropped).
 */
export async function decodeAudio(file: Blob, signal?: AbortSignal): Promise<Float32Array> {
  if (file.size > MAX_BYTES) throw new AiError('too-large');
  const stop = () => {
    if (signal?.aborted) throw new AiError('cancelled');
  };
  const data = await file.arrayBuffer();
  stop();
  let ctx: OfflineAudioContext;
  try {
    // decodeAudioData resamples to the context's rate, so the decoded audio is already 16 kHz: a third of 48 kHz.
    ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  } catch {
    ctx = new OfflineAudioContext(1, 1, 44_100); // a browser that won't run a context at 16 kHz
  }
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(data);
  } catch {
    stop();
    throw new AiError('corrupt');
  }
  stop();
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  // A copy: the channel data belongs to the AudioBuffer, and the samples will be transferred to the worker.
  const mono = channels.length === 1 ? channels[0]!.slice() : downmix(channels);
  return resample(mono, buf.sampleRate, SAMPLE_RATE);
}
