import type { Caps } from '../ai/capability';
import { AiError } from '../ai/errors';
import { MODEL_BASE_SET } from '../ai/config';
import { MAX_BYTES, MAX_SECONDS, SAMPLE_RATE, decodeAudio, hasSound, mediaDuration } from '../ai/whisper/audio';
import { whisperEngine, type WhisperPartial } from '../ai/whisper/engine';
import { toSrt, toTxt, toVtt, type Segment } from '../ai/whisper/subtitles';
import { sniff } from '../engine/sniff';
import type { AiToolDef } from './ai';
import { copyText } from './clipboard';

// Transcribe audio: the tool definition the shared AI island (ai.ts) runs. The file is decoded here, on the page,
// before anything downloads, so a file that is too long, damaged or silent is answered at once. The transcript
// shows as it comes, and only ever goes into the page as text.

interface TranscribeOut {
  segments: Segment[];
  /** The file's name without its extension: the downloads take it. */
  base: string;
}

const TOO_LONG = 'Audio up to 30 minutes for now.';
const TOO_LARGE = 'Files up to 300 MB for now. Try a shorter recording.';
const READING = 'Reading audio…';
const SLOW = 'This will be slow on this device (about as long as the audio).';
const NO_SPEECH = "We couldn't hear any speech in this file.";
const COPIED_MS = 1500;
/** Half a second of slack over the cap, for files that say 30:00 and hold a few samples more. */
const TOO_LONG_AFTER = MAX_SECONDS + 0.5;

/**
 * WebGPU on a computer whose GPU runs 16-bit shaders (the model's WebGPU files need them; without them WebGPU was
 * no faster than WebAssembly). Phones run on WebAssembly: their GPUs are slow to start and short of memory.
 */
export const usesWebGpu = (caps: Pick<Caps, 'webgpu' | 'webgpuF16' | 'mobile'>, hosted = MODEL_BASE_SET): boolean =>
  // Only where the model host holds the WebGPU runtime: one set for this build (the default host has none).
  hosted && caps.webgpu && caps.webgpuF16 && !caps.mobile;

const baseName = (name: string): string => name.replace(/\.[^./\\]*$/, '').trim() || 'transcript';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

function save(text: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); // time for the browser to start the download
}

export function transcribeDef(): AiToolDef<TranscribeOut> {
  /** Each checked file's sound (16 kHz mono) until it goes to the worker, and whether it is silent throughout. */
  const decoded = new WeakMap<File, { audio: Float32Array | null; silent: boolean }>();
  /** The run in progress is on WebAssembly: about as long as the audio. */
  let slow = false;

  return {
    verb: 'Transcribing',
    // The model's files for how this device runs it (./whisper/files.ts).
    modelKey: (caps) => (usesWebGpu(caps) ? 'whisperGpu' : 'whisper'),
    // The runtime downloads with the model on first use, and counts towards the size shown.
    withModel: (caps) => [usesWebGpu(caps) ? 'ortWebgpu' : 'ortWasm'],
    needsModel: (file) => decoded.get(file)?.silent !== true,
    cancelWork: true,
    inputName: 'audio or video file',
    messages: { 'too-long': TOO_LONG, 'too-large': TOO_LARGE },
    checking: READING,
    forget: (file) => void decoded.delete(file),
    workNote: () => (slow ? SLOW : undefined),

    async check(file, _caps, signal) {
      if (file.size > MAX_BYTES) throw new AiError('too-large'); // before anything reads it
      const { type } = await sniff(file);
      if (type !== 'unknown') throw new AiError('wrong-type', { detectedType: type }); // an image
      // The header's length first: a long file is turned away before it is decoded into memory.
      const seconds = await mediaDuration(file);
      if (seconds !== undefined && seconds > TOO_LONG_AFTER) throw new AiError('too-long');
      const audio = await decodeAudio(file, signal);
      if (audio.length / SAMPLE_RATE > TOO_LONG_AFTER) throw new AiError('too-long');
      decoded.set(file, { audio, silent: !hasSound(audio, SAMPLE_RATE) });
    },

    async run(file, caps, onProgress, { signal, live, modelKey }) {
      const base = baseName(file.name);
      const entry = decoded.get(file);
      if (!modelKey || !entry || entry.silent) return { segments: [], base }; // silence: no words, nothing to run
      // The samples go to the worker (transferred); a second run of the same file (Try again) decodes it again.
      const audio = entry.audio ?? (await decodeAudio(file));
      entry.audio = null;
      const webgpu = usesWebGpu(caps);
      slow = !webgpu;

      const text = h('p');
      live.append(text);
      const res = await whisperEngine.run(
        { audio: audio.buffer as ArrayBuffer, webgpu },
        [audio.buffer],
        (p) => {
          const part = p.partial as WhisperPartial | undefined;
          if (part) {
            slow = part.slow;
            // The transcript so far, whole: its last words may change as the next window is read.
            text.textContent = toTxt(part.segments);
            live.scrollTop = live.scrollHeight;
          }
          onProgress(p);
        },
        signal,
      );
      return { segments: res.segments, base };
    },

    renderResult({ segments, base }, root) {
      const words = toTxt(segments);
      if (!words) {
        root.append(h('p', {}, NO_SPEECH));
        return;
      }
      const box = h('textarea', { id: 'transcript', class: 'text-input prose', rows: '10', readonly: '', spellcheck: 'false' });
      box.value = words;
      const copied = h('span', { class: 'copied', 'aria-live': 'polite' });
      const copy = h('button', { type: 'button', class: 'btn' }, 'Copy');
      let timer: number | undefined;
      copy.addEventListener('click', async () => {
        if (!(await copyText(words))) return void box.select();
        copied.textContent = 'Copied';
        clearTimeout(timer);
        timer = window.setTimeout(() => (copied.textContent = ''), COPIED_MS);
      });
      const download = (ext: string, label: string, make: () => string, type: string) => {
        const b = h('button', { type: 'button', class: 'btn btn-quiet' }, label);
        b.addEventListener('click', () => save(make(), `${base}.${ext}`, type));
        return b;
      };
      root.append(
        h('div', { class: 'field' }, h('label', { for: 'transcript' }, 'Transcript'), box),
        h(
          'div',
          { class: 'actions' },
          copy,
          download('txt', 'Download .txt', () => words, 'text/plain'),
          download('srt', 'Download .srt', () => toSrt(segments), 'application/x-subrip'),
          download('vtt', 'Download .vtt', () => toVtt(segments), 'text/vtt'),
          copied,
        ),
      );
    },
  };
}
