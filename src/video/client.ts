import { createAiEngine, type AiProgress } from '../ai/client';
import type { Compressed, CompressOptions } from './compress';
import type { GifOptions } from './gif';
import type { VideoOp } from './limits';
import type { Probed, VideoRequest, VideoResult } from './worker';

export type { CompressOptions, GifOptions, Probed };

/** A compressed video, as the page holds it. */
export interface CompressedVideo extends Omit<Compressed, 'mp4'> {
  blob: Blob;
}

// One worker for the page, started with the first video. The AI tools' client runs it: one job at a time, a worker
// that dies is replaced for the next job, and Cancel (the signal) terminates it mid-job. Rejects with AiError.
const engine = createAiEngine<VideoRequest, VideoResult>(() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));

/** Read a file and check it against `op`'s limits. */
export const probeVideo = (file: File, op: VideoOp, signal?: AbortSignal): Promise<Probed> =>
  engine.run({ op: 'probe', file, for: op }, [], undefined, signal) as Promise<Probed>;

export const compressVideo = (
  file: File,
  opts: CompressOptions,
  onProgress: (p: AiProgress) => void,
  signal?: AbortSignal,
): Promise<CompressedVideo> =>
  (engine.run({ op: 'compress', file, ...opts }, [], onProgress, signal) as Promise<Compressed>).then(({ mp4, ...rest }) => ({
    ...rest,
    // The worker's buffer, transferred: wrapped here and let go, so the page holds the video once.
    blob: new Blob([mp4], { type: 'video/mp4' }),
  }));

/** The GIF of a trimmed span (a Blob from the worker: passed by reference, not copied). */
export const makeGif = (file: File, opts: GifOptions, onProgress: (p: AiProgress) => void, signal?: AbortSignal): Promise<Blob> =>
  engine.run({ op: 'gif', file, ...opts }, [], onProgress, signal) as Promise<Blob>;
