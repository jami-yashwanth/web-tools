import type { AiWorkerRequest, AiWorkerResponse } from '../ai/client';
import { AiError, reasonOf } from '../ai/errors';
import { compressVideo, type CompressOptions, type Compressed } from './compress';
import { checkDecodable, demux } from './demux';
import { makeGif, type GifOptions } from './gif';
import { checkLimits, type VideoOp } from './limits';

// The video worker: one job at a time (protocol: ../ai/client.ts). `probe` reads a file's boxes and says whether `for`
// (the op to come) can work on it at all (its limits, and whether this browser decodes its picture); `compress` makes the MP4 and
// `gif` the GIF.

export interface Probed {
  durationS: number;
  width: number;
  height: number;
}

export type VideoRequest =
  | { op: 'probe'; file: File; for: VideoOp }
  | ({ op: 'compress'; file: File } & CompressOptions)
  | ({ op: 'gif'; file: File } & GifOptions);
export type VideoResult = Probed | Compressed | Blob;

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<AiWorkerRequest<VideoRequest>>) => void) | null;
  postMessage(message: AiWorkerResponse<VideoResult>, transfer?: Transferable[]): void;
};

async function probe(file: File, op: VideoOp): Promise<Probed> {
  const d = await demux(file);
  const limit = checkLimits({ durationS: d.durationS, bytes: file.size }, op);
  if (limit !== 'ok') throw new AiError(limit);
  await checkDecodable(d.video);
  const { width, height } = d.video;
  // Shown as the picture plays: a phone's portrait video is stored landscape, turned a quarter.
  const turned = d.video.rotation === 90 || d.video.rotation === 270;
  return { durationS: d.durationS, width: turned ? height : width, height: turned ? width : height };
}

/** The AiError a failure stands for. Anything unexpected is shown as a damaged file, and logged. */
function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  console.error('video worker: unexpected error', err);
  return new AiError('corrupt');
}

scope.onmessage = async (e) => {
  const { id, req } = e.data;
  try {
    const onProgress = (done: number, total: number) => scope.postMessage({ kind: 'progress', id, stage: 'work', done, total });
    const result =
      req.op === 'probe'
        ? await probe(req.file, req.for)
        : req.op === 'compress'
          ? await compressVideo(req.file, { preset: req.preset, resolution: req.resolution }, onProgress)
          : await makeGif(req.file, { start: req.start, end: req.end, width: req.width, fps: req.fps }, onProgress);
    scope.postMessage({ kind: 'done', id, result }, 'mp4' in result ? [result.mp4] : []);
  } catch (raw) {
    const err = toAiError(raw);
    scope.postMessage({ kind: 'failed', id, reason: reasonOf(err), ...(err.detectedType ? { detectedType: err.detectedType } : {}) });
  }
};
