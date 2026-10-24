import type { Preset, Resolution } from '../video/limits';
import { formatBytes } from './format';
import { baseName, createVideoShell, type VideoHooks } from './video-shell';

// Compress video (VideoCompressScript.astro): the file, read, with Quality and Max width → Compress →
// "Compressing… n%" with Cancel → "<in> → <out>" with Download MP4 and Start over. The shared states are in
// video-shell.ts.

export type { VideoHooks };

const NO_ENCODE = "Your browser can't encode video. Try Chrome, Edge, Safari 17+ or Firefox 130+.";
const SOUND_DROPPED = "This video's sound couldn't be kept.";
const NOT_SMALLER = 'This video was already well compressed.';

/** WebCodecs, the browser's own video encoder and decoder: without them there is nothing this tool can do. */
const canEncode = (): boolean => typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';

export function mountCompress(el: HTMLElement): VideoHooks {
  // No H.264 encoder for this video (or none at all): the browser can't do this.
  const shell = createVideoShell(el, { op: 'compress', supported: canEncode(), deviceCopy: NO_ENCODE, verb: 'Compressing' });
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  const sizes = q('[data-video-sizes]');
  const notes = q('[data-video-notes]');
  const checked = (name: string) => el.querySelector<HTMLInputElement>(`input[name=${name}]:checked`)!.value;

  async function run(): Promise<void> {
    const preset = checked('preset') as Preset;
    const resolution = (Number(checked('resolution')) || null) as Resolution;
    const out = await shell.work(
      (client, file, onProgress, signal) => client.compressVideo(file, { preset, resolution }, onProgress, signal).then((r) => ({ ...r, file })),
      () => void run(),
    );
    if (!out) return;
    sizes.textContent = `${formatBytes(out.inBytes)} → ${formatBytes(out.outBytes)}`;
    const lines = [out.outBytes >= out.inBytes ? NOT_SMALLER : '', out.soundDropped ? SOUND_DROPPED : ''].filter(Boolean);
    notes.textContent = lines.join(' ');
    notes.hidden = !lines.length;
    shell.finish(out.blob, `${baseName(out.file.name)}-compressed.mp4`, `Done. ${sizes.textContent}`);
  }
  q('[data-run]').addEventListener('click', () => void run());

  return shell.hooks;
}
