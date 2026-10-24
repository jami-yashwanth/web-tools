import { CodecLoadError, load } from '../../engine/codecs';
import { DecodeError, decode } from '../../engine/decode';
import { applyOrientation, downscaleTo, flattenOnWhite } from '../../engine/pixels';
import { sniff } from '../../engine/sniff';
import { AiError } from '../errors';

// The OCR itself: decode the image (EXIF orientation applied), hand tesseract.js a PNG, read the text. It runs in
// the OCR worker (worker.ts) and, with tesseract's Node worker, in the unit tests. Where tesseract finds its own
// files differs by host, so the caller passes them in.

export interface OcrResult {
  text: string;
  /** Mean word confidence, 0 to 100. */
  confidence: number;
}

export interface OcrSource {
  /**
   * A URL or directory that holds `eng.traineddata.gz`. tesseract.js fetches `<langPath>/eng.traineddata.gz` itself
   * (it cannot be handed the bytes: its `{ code, data }` form is broken), so the worker passes a blob: URL of the
   * bytes our loader already downloaded and cached.
   */
  langPath: string;
  /** tesseract's own worker script and core. Omit in Node, where tesseract finds both itself. */
  workerPath?: string;
  corePath?: string;
}

/** English fast data is 4.1 MB once unpacked; anything far below that is not a language file. */
const MIN_TRAINEDDATA_BYTES = 1_000_000;

/**
 * Is this a gzipped traineddata file? Throws AiError network+badModel if not (an error page served with 200, or a
 * damaged cache entry). Checked before tesseract sees the bytes: it reports bad data only through a failing worker.
 */
export async function assertTraineddata(gz: Uint8Array): Promise<void> {
  const bad = () => new AiError('network', { badModel: true });
  if (gz.length < 2 || gz[0] !== 0x1f || gz[1] !== 0x8b) throw bad();
  try {
    const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    let total = 0;
    const reader = stream.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) total += r.value.byteLength;
    if (total < MIN_TRAINEDDATA_BYTES) throw bad();
  } catch {
    throw bad();
  }
}

/** Photos beyond this are shrunk first; reading text off a 50 MP photo only costs time and memory. */
const MAX_MEGAPIXELS = 16;
const PNG_LEVEL = 0; // fastest: this PNG is read once, by tesseract

/** Orientation-corrected, flattened onto white (transparent text backgrounds would read as black), as a PNG. */
export async function toPng(bytes: ArrayBuffer): Promise<Uint8Array> {
  const { type } = await sniff(new Blob([bytes]));
  if (type === 'unknown') throw new AiError('wrong-type');
  try {
    let pixels = applyOrientation(await decode(bytes, type));
    if (pixels.hasAlpha) pixels = flattenOnWhite(pixels);
    pixels = downscaleTo(pixels, MAX_MEGAPIXELS);
    return (await load.oxipng()).optimise_raw(pixels.data, pixels.width, pixels.height, PNG_LEVEL, false, false);
  } catch (err) {
    if (err instanceof CodecLoadError) throw new AiError('network');
    if (err instanceof DecodeError) throw new AiError('corrupt');
    throw err;
  }
}

/**
 * Read the text in an image. `onProgress(done, total)` reports the reading itself. Rejects with an AiError:
 * corrupt (the image), network (tesseract's own files could not load) or network with `badModel` (the language
 * data would not parse).
 */
export async function recogniseBytes(
  bytes: ArrayBuffer,
  source: OcrSource,
  onProgress?: (done: number, total: number) => void,
): Promise<OcrResult> {
  const png = await toPng(bytes);

  // tesseract.js only reports a failure through its logger and errorHandler (its createWorker() promise just hangs
  // when the language data is bad), so every step races this.
  let fail: (reason: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => (fail = reject));
  failed.catch(() => {});
  let coreLoaded = false;

  let reported = 0;
  const report = (pct: number) => {
    reported = Math.max(reported, pct); // never backwards
    onProgress?.(reported, 100);
  };

  const { createWorker } = await import('tesseract.js');
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let creating: ReturnType<typeof createWorker> | undefined;
  try {
    creating = createWorker('eng', 1, {
        ...(source.workerPath ? { workerPath: source.workerPath } : {}),
        ...(source.corePath ? { corePath: source.corePath } : {}),
        langPath: source.langPath,
        gzip: true,
        cacheMethod: 'none', // our loader is the one cache
        logger: (m) => {
          if (m.status === 'loading tesseract core' && m.progress === 1) coreLoaded = true;
          if (m.status === 'recognizing text') report(Math.round(m.progress * 100));
        },
        errorHandler: fail,
      });
    worker = await Promise.race([creating, failed]);
  } catch {
    // If it comes up after we gave up on it, stop it: nothing else holds a reference.
    void creating?.then((late) => late.terminate()).catch(() => {});
    // Past the core, what failed is the language data (a bad download or cache entry); before it, tesseract's own files.
    throw coreLoaded ? new AiError('network', { badModel: true }) : new AiError('network');
  }

  try {
    // tesseract's types say Buffer (Node); at run time any Uint8Array is read, in the browser and in Node.
    const { data } = await Promise.race([worker.recognize(png as Parameters<typeof worker.recognize>[0]), failed]);
    report(100);
    return { text: data.text, confidence: data.confidence };
  } catch (err) {
    if (err instanceof AiError) throw err;
    throw new AiError('corrupt');
  } finally {
    void worker.terminate().catch(() => {});
  }
}
