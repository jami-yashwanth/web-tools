import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import { AiError } from '../ai/errors';
import { checkDecodable, demux, type SampleRef } from './demux';
import { createPicker, decodeSpan, gifSize, sampleTimes, type GifFps, type GifWidth } from './frames';
import { checkLimits } from './limits';

// Video to GIF, in the worker: mp4box.js demux → VideoDecoder over the trimmed span only (from the keyframe before
// it) → the decoded frame nearest each sample time, drawn upright and scaled on an OffscreenCanvas → gifenc, one
// palette per frame, written as it comes. Every other frame is closed at once: at most one decoded frame is held, and
// the GIF's bytes are the only thing that grows. Needs no video encoder.

export interface GifOptions {
  /** The trim, in seconds from the start of the video. */
  start: number;
  end: number;
  width: GifWidth;
  fps: GifFps;
}

/** Frames waiting in the decoder before the next sample is read. */
const MAX_QUEUE = 8;
/** Opaque video: all 16 bits of a palette key go to colour. */
const FORMAT = 'rgb565';

async function read(file: Blob, s: SampleRef): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(s.offset, s.offset + s.size).arrayBuffer());
}

/** Resolves when `ready()` holds, checking as the decoder works through its queue. */
async function until(ready: () => boolean, failure: () => AiError | null): Promise<void> {
  for (;;) {
    const f = failure();
    if (f) throw f;
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Throws AiError: too-large (the video's size: its length isn't capped, only the span), unsupported (format), device (no decoder), corrupt. */
export async function makeGif(file: File, opts: GifOptions, onProgress: (done: number, total: number) => void): Promise<Blob> {
  const d = await demux(file);
  const limit = checkLimits({ durationS: d.durationS, bytes: file.size }, 'gif');
  if (limit !== 'ok') throw new AiError(limit);
  const { video } = d;
  const config = await checkDecodable(video);

  const times = sampleTimes(opts.start, opts.end, opts.fps);
  // Sample times count from the first frame shown, as the page's <video> does.
  const base = video.samples.reduce((m, s) => Math.min(m, s.timestamp), Infinity);
  const timesUs = times.map((t) => base + Math.round(t * 1e6));
  const { from, to } = decodeSpan(video.samples, timesUs[0]!, base + Math.round(opts.end * 1e6));

  const size = gifSize(video.width, video.height, video.rotation, opts.width);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new AiError('device');
  // Upright: turn about the centre, and draw the stored picture at its own (unturned) shape.
  const turned = video.rotation === 90 || video.rotation === 270;
  const [drawW, drawH] = turned ? [size.height, size.width] : [size.width, size.height];
  ctx.translate(size.width / 2, size.height / 2);
  ctx.rotate((video.rotation * Math.PI) / 180);

  const gif = GIFEncoder();
  // Progress: the samples decoded, then the GIF frames written.
  const total = to - from + times.length;
  let decoded = 0;
  let written = 0; // samples written to the GIF so far
  let lastPct = -1;
  const progress = () => {
    const done = Math.min(total, decoded + written);
    const pct = Math.floor((done / total) * 100);
    if (pct === lastPct) return;
    lastPct = pct;
    onProgress(done, total);
  };

  let failure: AiError | null = null;
  /** Set once the run is over, however it ended: the picker then only lets go of frames, never draws. */
  let stopped = false;
  const fail = (reason: 'corrupt' | 'device') => (err: unknown) => {
    console.error(`gif: ${reason === 'corrupt' ? 'decoding' : 'drawing'} failed`, err);
    failure ??= new AiError(reason);
  };

  const picker = createPicker<VideoFrame>(
    timesUs,
    (frame, samples) => {
      if (failure || stopped) return; // after a failure, frames are only let go of
      ctx.drawImage(frame, -drawW / 2, -drawH / 2, drawW, drawH);
      const { data } = ctx.getImageData(0, 0, size.width, size.height);
      const palette = quantize(data, 256, { format: FORMAT });
      const index = applyPalette(data, palette, FORMAT);
      // In hundredths of a second, rounded on the running total so 15 fps doesn't drift (7, 6, 7, 7, 6…).
      const cs = Math.round(((written + samples) * 100) / opts.fps) - Math.round((written * 100) / opts.fps);
      gif.writeFrame(index, size.width, size.height, { palette, delay: cs * 10, repeat: 0 });
      written += samples;
      progress();
    },
    (frame) => frame.close(),
  );

  const decoder = new VideoDecoder({
    output: (frame) => {
      if (failure || stopped) return frame.close();
      try {
        picker.push(frame, frame.timestamp);
      } catch (err) {
        fail('device')(err);
      }
    },
    error: fail('corrupt'),
  });

  try {
    decoder.configure(config);
    for (let i = from; i < to && !picker.done; i++) {
      await until(() => decoder.decodeQueueSize < MAX_QUEUE, () => failure);
      const s = video.samples[i]!;
      const data = await read(file, s);
      try {
        decoder.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.timestamp, duration: s.duration, data }));
      } catch (err) {
        fail('corrupt')(err);
        throw failure!;
      }
      decoded++;
      progress();
    }
    decoded = to - from; // stopped early once every sample had its frame: the rest needn't be decoded
    await decoder.flush().catch((err) => fail('corrupt')(err));
    if (failure) throw failure;
    picker.finish();
    if (failure) throw failure;
  } finally {
    stopped = true;
    if (decoder.state !== 'closed') decoder.close();
    try {
      picker.finish(); // after a throw: lets go of the frame it holds, drawing nothing
    } catch (err) {
      console.error('gif: letting go of frames failed', err); // never masks the error that ended the run
    }
  }
  if (!written) throw new AiError('corrupt'); // nothing in the span could be decoded

  gif.finish();
  return new Blob([gif.bytesView()], { type: 'image/gif' });
}
