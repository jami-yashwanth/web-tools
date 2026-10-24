import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { AiError } from '../ai/errors';
import { checkDecodable, demux, isAac, type SampleRef } from './demux';
import { checkLimits, encoderCodecs, outputSize, targetBitrate, type Preset, type Resolution } from './limits';

// Compress video, in the worker: mp4box.js demux → VideoDecoder → scale (OffscreenCanvas, when the size changes) →
// VideoEncoder (H.264) → mp4-muxer. AAC sound is copied through untouched; other sound is left out. The decoder's and
// the encoder's queues are kept short, and every VideoFrame is closed as soon as it has been handed on, so memory
// stays flat however long the video.

export interface CompressOptions {
  preset: Preset;
  resolution: Resolution;
}

export interface Compressed {
  /**
   * The MP4. A bare buffer, not a Blob: the worker transfers it to the page, which wraps it in a Blob and lets it go,
   * so no third copy of the output is ever held (the muxer's chunks and this buffer are the worker's two).
   */
  mp4: ArrayBuffer;
  inBytes: number;
  outBytes: number;
  /** The video had sound that isn't AAC, which was left out. */
  soundDropped: boolean;
}

/** Frames waiting in the decoder, or in the encoder, before the next sample is read. */
const MAX_QUEUE = 8;
/** A keyframe every 2 seconds, so the result can be seeked. */
const KEYFRAME_SECONDS = 2;

/** The first H.264 codec this browser can encode at this size, or undefined. */
async function pickEncoder(width: number, height: number, frameRate: number, bitrate: number): Promise<VideoEncoderConfig | undefined> {
  if (typeof VideoEncoder === 'undefined') return undefined;
  for (const codec of encoderCodecs(width, height, frameRate)) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: frameRate, avc: { format: 'avc' } };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch {
      // A codec string this browser doesn't know: try the next.
    }
  }
  return undefined;
}

async function read(file: Blob, s: SampleRef): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(s.offset, s.offset + s.size).arrayBuffer());
}

/** Resolves when `ready()` holds, checking as the codecs work through their queues. */
async function until(ready: () => boolean, failure: () => AiError | null): Promise<void> {
  for (;;) {
    const f = failure();
    if (f) throw f;
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Throws AiError: too-long / too-large (limits), unsupported (format), device (no H.264 encoding), corrupt. */
export async function compressVideo(
  file: File,
  opts: CompressOptions,
  onProgress: (done: number, total: number) => void,
): Promise<Compressed> {
  const d = await demux(file);
  const limit = checkLimits({ durationS: d.durationS, bytes: file.size }, 'compress');
  if (limit !== 'ok') throw new AiError(limit);
  const { video } = d;

  const config = await checkDecodable(video);

  const size = outputSize(video.width, video.height, opts.resolution);
  const frameRate = Math.min(120, Math.max(1, video.frameRate));
  const encoderConfig = await pickEncoder(size.width, size.height, frameRate, targetBitrate(opts.preset, size.width, size.height));
  if (!encoderConfig) throw new AiError('device');

  const sound = d.audio && isAac(d.audio.codec) && d.audio.sampleRate > 0 && d.audio.channels > 0 ? d.audio : undefined;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: size.width, height: size.height, rotation: video.rotation },
    ...(sound ? { audio: { codec: 'aac' as const, numberOfChannels: sound.channels, sampleRate: sound.sampleRate } } : {}),
    fastStart: 'in-memory',
    // Each track starts at its first sample (an edit list in the source shifts them the same way).
    firstTimestampBehavior: 'offset',
  });

  // The sound first: it is small, and the muxer holds it until the picture catches up.
  if (sound) {
    for (const [i, s] of sound.samples.entries()) {
      const meta: EncodedAudioChunkMetadata | undefined =
        i === 0
          ? {
              decoderConfig: {
                codec: sound.codec,
                sampleRate: sound.sampleRate,
                numberOfChannels: sound.channels,
                ...(sound.description ? { description: sound.description } : {}),
              },
            }
          : undefined;
      muxer.addAudioChunkRaw(await read(file, s), 'key', s.timestamp, s.duration, meta);
    }
  }

  let failure: AiError | null = null;
  const fail = (reason: 'corrupt' | 'device') => (err: unknown) => {
    console.error(`compress: ${reason === 'corrupt' ? 'decoding' : 'encoding'} failed`, err);
    failure ??= new AiError(reason);
  };
  const total = video.samples.length;
  let encoded = 0;
  let lastPct = -1;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (err) {
        fail('device')(err);
        return;
      }
      encoded++;
      const pct = Math.floor((Math.min(encoded, total) / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        onProgress(Math.min(encoded, total), total);
      }
    },
    error: fail('device'),
  });
  encoder.configure(encoderConfig);

  const scale = size.width !== video.width || size.height !== video.height;
  const canvas = scale ? new OffscreenCanvas(size.width, size.height) : null;
  const ctx = canvas?.getContext('2d') ?? null;
  const keyEvery = Math.max(1, Math.round(frameRate * KEYFRAME_SECONDS));
  let frames = 0;
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        if (failure) return;
        const keyFrame = frames++ % keyEvery === 0;
        if (ctx && canvas) {
          ctx.drawImage(frame, 0, 0, size.width, size.height);
          const scaled = new VideoFrame(canvas, { timestamp: frame.timestamp, ...(frame.duration ? { duration: frame.duration } : {}) });
          try {
            encoder.encode(scaled, { keyFrame });
          } finally {
            scaled.close();
          }
        } else encoder.encode(frame, { keyFrame });
      } catch (err) {
        fail('device')(err);
      } finally {
        frame.close();
      }
    },
    error: fail('corrupt'),
  });

  try {
    decoder.configure(config);
    for (const s of video.samples) {
      await until(() => decoder.decodeQueueSize < MAX_QUEUE && encoder.encodeQueueSize < MAX_QUEUE, () => failure);
      const data = await read(file, s);
      try {
        decoder.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.timestamp, duration: s.duration, data }));
      } catch (err) {
        fail('corrupt')(err); // a first sample that isn't a keyframe, say
        throw failure!;
      }
    }
    await decoder.flush().catch((err) => fail('corrupt')(err));
    if (failure) throw failure;
    await encoder.flush().catch((err) => fail('device')(err));
    if (failure) throw failure;
  } finally {
    if (decoder.state !== 'closed') decoder.close();
    if (encoder.state !== 'closed') encoder.close();
  }
  if (!encoded) throw new AiError('corrupt'); // nothing in it could be decoded

  muxer.finalize();
  const mp4 = muxer.target.buffer;
  return {
    mp4,
    inBytes: file.size,
    outBytes: mp4.byteLength,
    soundDropped: !!d.audio && !sound,
  };
}
