import { checkTrim, gifSize, isLargeGif, type GifFps, type GifWidth } from '../video/frames';
import { formatBytes } from './format';
import { baseName, createVideoShell, type VideoHooks } from './video-shell';

// Video to GIF (VideoGifScript.astro): the file, read, with a preview to find the moment in, Start and End (seconds),
// Width and Frame rate → Make GIF → "Making GIF… n%" with Cancel → the GIF itself, its size, Download GIF and Start
// over. The shared states are in video-shell.ts.

/** A GIF needs only the browser's video decoder (no encoder). */
const NO_DECODE = "Your browser can't read video. Try Chrome, Edge, Safari 17+ or Firefox 130+.";
const SPAN = 'GIFs can be up to 15 seconds.';
const RANGE = 'End must be after start and within the video.';
const LARGE = 'Large GIF. Try 320 px or a shorter clip for a smaller file.';
/** The clip offered at first: from the start, up to 5 s of it. */
const DEFAULT_SECONDS = 5;

export function mountGif(el: HTMLElement): VideoHooks {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  const preview = q<HTMLVideoElement>('[data-preview]');
  const startIn = q<HTMLInputElement>('[data-start]');
  const endIn = q<HTMLInputElement>('[data-end]');
  const trimError = q('[data-trim-error]');
  const gifImg = q<HTMLImageElement>('[data-gif]');
  const sizes = q('[data-video-sizes]');
  const note = q('[data-gif-note]');
  let previewUrl: string | null = null;

  function showTrimError(text: string | null, field?: HTMLInputElement): void {
    trimError.textContent = text ?? '';
    trimError.hidden = !text;
    for (const f of [startIn, endIn]) f.toggleAttribute('aria-invalid', f === field);
    field?.focus();
  }

  const shell = createVideoShell(el, {
    op: 'gif',
    supported: typeof VideoDecoder !== 'undefined',
    deviceCopy: NO_DECODE,
    verb: 'Making GIF',
    onFile(file, info) {
      previewUrl = URL.createObjectURL(file);
      preview.src = previewUrl;
      const max = String(Math.ceil(info.durationS * 10) / 10);
      startIn.max = max;
      endIn.max = max;
      startIn.value = '0';
      endIn.value = String(Math.max(0.1, Math.min(DEFAULT_SECONDS, Math.floor(info.durationS * 10) / 10)));
      showTrimError(null);
    },
    onFileCleared() {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null;
      preview.removeAttribute('src');
      preview.load(); // lets go of the video it had
    },
    onResultCleared() {
      gifImg.removeAttribute('src');
    },
  });

  const checked = (name: string) => Number(el.querySelector<HTMLInputElement>(`input[name=${name}]:checked`)!.value);

  async function run(): Promise<void> {
    const ready = shell.current();
    if (!ready) return;
    const start = startIn.valueAsNumber;
    const end = endIn.valueAsNumber;
    const trim = checkTrim({ start, end, durationS: ready.info.durationS });
    if (trim !== 'ok') {
      if (trim === 'too-long') shell.failed('too-long'); // the tool's limit; a mistyped range is not a failure
      showTrimError(trim === 'too-long' ? SPAN : RANGE, trim === 'invalid' && !(start >= 0) ? startIn : endIn);
      return;
    }
    showTrimError(null);
    preview.pause();
    const width = checked('width') as GifWidth;
    const fps = checked('fps') as GifFps;
    const out = await shell.work(
      (client, file, onProgress, signal) => client.makeGif(file, { start, end, width, fps }, onProgress, signal).then((gif) => ({ gif, file })),
      () => void run(),
    );
    if (!out) return;
    const size = gifSize(ready.info.width, ready.info.height, 0, width); // the probe's size is upright already
    sizes.textContent = `${size.width} × ${size.height} · ${formatBytes(out.gif.size)}`;
    const large = isLargeGif(out.gif.size);
    note.textContent = large ? LARGE : '';
    note.hidden = !large;
    gifImg.src = shell.finish(out.gif, `${baseName(out.file.name)}.gif`, `Done. ${sizes.textContent}${large ? ` ${LARGE}` : ''}`);
  }
  q('[data-run]').addEventListener('click', () => void run());

  return shell.hooks;
}
