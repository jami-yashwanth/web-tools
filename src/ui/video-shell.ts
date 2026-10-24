import type { AiProgress } from '../ai/client';
import { AiError, reasonOf, type AiFail } from '../ai/errors';
import { MAX_BYTES, UNDECODABLE, type VideoOp } from '../video/limits';
import type { Probed } from '../video/client';
import { formatBytes, middleTruncate } from './format';

// What both video islands share (Compress video in video.ts, Video to GIF in video-gif.ts): empty → the file, read
// (its size, length and whether it can be decoded) → the op's own settings and button → "<Verb>… n%" with Cancel →
// the result with Download and Start over, or an alert. The work runs in a worker (src/video/worker.ts) loaded with
// the first file. File names only ever go into the page as text.

export interface VideoHooks {
  /** `cb(count)` after each video made (count is always 1). */
  onSuccess(cb: (count: number) => void): void;
  /** `cb(reason)` for each failure the user sees, including Cancel. */
  onError(cb: (reason: AiFail) => void): void;
}

type Client = typeof import('../video/client');

export interface ShellOptions {
  /** Which op: its limits are checked as the file is read. */
  op: VideoOp;
  /** Can this browser do the op at all? Checked once, as the page loads. */
  supported: boolean;
  /** What a `device` failure, or a browser that can't do the op at all, says. */
  deviceCopy: string;
  /** "Compressing", "Making GIF": the working panel says "<verb>… n%". */
  verb: string;
  /** A file has been read and can be worked on: the op sets up its own controls. */
  onFile?(file: File, info: Probed): void;
  /** The file is let go of (another file, Start over): the op lets go of what it made of it. */
  onFileCleared?(): void;
  /** The result is let go of (another run, another file, Start over). */
  onResultCleared?(): void;
}

/** Compress caps length and size; Video to GIF only the size (its span is capped on its own). */
const LIMITS: Record<VideoOp, string> = {
  compress: 'Videos up to 2 minutes and 200 MB for now.',
  gif: 'Videos up to 200 MB for now.',
};
const DAMAGED = "We couldn't read this file. It may be damaged or incomplete.";
const COPY: Record<Exclude<AiFail, 'device' | 'too-long' | 'too-large'>, string> = {
  unsupported: "This video format isn't supported yet. Try an MP4 or MOV.",
  corrupt: DAMAGED,
  network: "Couldn't load the video tools. Check your connection.",
  encrypted: DAMAGED,
  'wrong-type': "This file isn't a video.",
  cancelled: '',
};
/** The file reads fine, but this browser can't decode its picture (HEVC in Firefox, say): another browser can. */
const UNDECODABLE_COPY = "This browser can't play this video's format. Try Chrome, Edge or Safari.";
const TYPE_NAMES: Record<string, string> = { jpg: 'JPG', png: 'PNG', webp: 'WebP', heic: 'HEIC', pdf: 'PDF' };
const ELSEWHERE: Record<string, { href: string; h1: string }> = {
  jpg: { href: '/compress-image/', h1: 'Compress image' },
  png: { href: '/compress-image/', h1: 'Compress image' },
  webp: { href: '/compress-image/', h1: 'Compress image' },
  heic: { href: '/heic-to-jpg/', h1: 'HEIC to JPG' },
};
const NAME_MAX = 40;

export const baseName = (name: string): string => name.replace(/\.[^./\\]*$/, '').trim() || 'video';
const clock = (s: number): string => {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

export function createVideoShell(el: HTMLElement, opts: ShellOptions) {
  const successListeners: ((count: number) => void)[] = [];
  const errorListeners: ((reason: AiFail) => void)[] = [];
  const failed = (reason: AiFail) => errorListeners.forEach((cb) => cb(reason));

  const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  const drop = q('.drop');
  const input = q<HTMLInputElement>('input[type=file]');
  const status = q('[data-status]');
  const alert = q('[data-video-alert]');
  const alertText = q('[data-alert-text]');
  const tryLink = q<HTMLAnchorElement>('[data-try]');
  const retryBtn = q<HTMLButtonElement>('[data-retry]');
  const fileBox = q('[data-video-file]');
  const nameEl = q('[data-name]');
  const metaEl = q('[data-meta]');
  const runBtn = q<HTMLButtonElement>('[data-run]');
  const panel = q('[data-video-panel]');
  const panelText = q('[data-panel-text]');
  const bar = panel.querySelector('progress')!;
  const cancelBtn = q<HTMLButtonElement>('[data-cancel]');
  const done = q('[data-video-done]');
  const downloadBtn = q<HTMLButtonElement>('[data-download]');
  const resetBtn = q<HTMLButtonElement>('[data-reset]');

  let gen = 0; // bumped by every new file, run, Cancel and Start over: late answers from before are dropped
  let current: { file: File; info: Probed } | null = null;
  let controller: AbortController | null = null;
  let running = false;
  let url: string | null = null;
  let outName = '';
  let onRetry: (() => void) | null = null;

  /** Announce to screen readers only; what's on screen says the same. */
  function say(text: string): void {
    status.textContent = text;
    status.classList.add('visually-hidden');
  }
  function show(parts: { drop?: boolean; file?: boolean; panel?: boolean; done?: boolean; alert?: boolean }): void {
    drop.hidden = !parts.drop;
    fileBox.hidden = !parts.file;
    panel.hidden = !parts.panel;
    done.hidden = !parts.done;
    alert.hidden = !parts.alert;
    drop.classList.toggle('drop-compact', !!parts.file);
  }
  function revokeResult(): void {
    if (url) URL.revokeObjectURL(url);
    url = null;
    opts.onResultCleared?.();
  }
  function clearFile(): void {
    current = null;
    opts.onFileCleared?.();
  }
  function abort(): void {
    controller?.abort();
    controller = null;
    running = false;
  }
  const loadClient = (): Promise<Client> => import('../video/client').catch(() => Promise.reject(new AiError('network')));

  /** Show a failure under the drop zone (another file is the way on), or on its own with Try again. */
  function fail(err: unknown, retry?: () => void): void {
    if (!(err instanceof AiError)) console.error('video: unexpected failure', err);
    const reason = reasonOf(err);
    failed(reason);
    const type = err instanceof AiError ? err.detectedType : undefined;
    let text =
      reason === 'device'
        ? opts.deviceCopy
        : reason === 'too-long' || reason === 'too-large'
          ? LIMITS[opts.op]
          : reason === 'unsupported' && type === UNDECODABLE
            ? UNDECODABLE_COPY
            : COPY[reason];
    tryLink.hidden = true;
    if (reason === 'wrong-type' && type && TYPE_NAMES[type]) {
      text = `This is a ${TYPE_NAMES[type]}, not a video.`;
      const target = ELSEWHERE[type];
      if (target) {
        tryLink.href = target.href;
        tryLink.textContent = `Try ${target.h1} →`;
        tryLink.hidden = false;
      }
    }
    alertText.textContent = text;
    onRetry = retry ?? null;
    retryBtn.hidden = !retry;
    if (retry) {
      show({ alert: true });
      retryBtn.focus();
    } else show({ drop: true, alert: true });
    say('');
  }
  retryBtn.addEventListener('click', () => onRetry?.());

  // --- a file: read it, then offer the op ---
  async function take(file: File): Promise<void> {
    abort();
    revokeResult();
    clearFile();
    const g = ++gen;
    if (file.size > MAX_BYTES) return fail(new AiError('too-large')); // before reading any of it
    if (file.size === 0) return fail(new AiError('corrupt'));
    nameEl.textContent = middleTruncate(file.name, NAME_MAX);
    nameEl.title = file.name;
    metaEl.textContent = 'Reading…';
    runBtn.disabled = true;
    show({ drop: true, file: true });
    say('Reading the video…');
    const ctrl = new AbortController();
    controller = ctrl;
    try {
      const { probeVideo } = await loadClient();
      const info = await probeVideo(file, opts.op, ctrl.signal);
      if (g !== gen) return;
      controller = null;
      current = { file, info };
      metaEl.textContent = `${info.width} × ${info.height} · ${clock(info.durationS)} · ${formatBytes(file.size)}`;
      opts.onFile?.(file, info);
      runBtn.disabled = false;
      say(`${file.name}, ${metaEl.textContent}`);
    } catch (err) {
      if (g !== gen) return;
      controller = null;
      fail(err, reasonOf(err) === 'network' ? () => void take(file) : undefined);
    }
  }

  /**
   * Run the op on the current file: the working panel with Cancel while `job` runs. Resolves with what the job made,
   * or undefined when there is nothing to show (no file, already running, cancelled, failed: each shown already).
   * `retry` is offered when the video tools couldn't load.
   */
  async function work<R>(
    job: (client: Client, file: File, onProgress: (p: AiProgress) => void, signal: AbortSignal) => Promise<R>,
    retry: () => void,
  ): Promise<R | undefined> {
    const file = current?.file;
    if (!file || running) return undefined;
    revokeResult();
    const g = ++gen;
    const ctrl = new AbortController();
    controller = ctrl;
    running = true;
    panelText.textContent = `${opts.verb}… 0%`;
    bar.value = 0;
    show({ panel: true });
    cancelBtn.focus();
    say(`${opts.verb}…`);
    const onProgress = (p: AiProgress) => {
      if (g !== gen) return;
      const pct = p.total > 0 ? Math.min(100, Math.floor((p.done / p.total) * 100)) : 0;
      panelText.textContent = `${opts.verb}… ${pct}%`;
      bar.value = pct;
    };
    try {
      const out = await job(await loadClient(), file, onProgress, ctrl.signal);
      if (g !== gen) return undefined;
      running = false;
      controller = null;
      return out;
    } catch (err) {
      if (g !== gen) return undefined;
      running = false;
      controller = null;
      if (reasonOf(err) === 'cancelled') cancelled();
      else fail(err, reasonOf(err) === 'network' ? retry : undefined);
      return undefined;
    }
  }

  /** Show the result: `blob` is what Download saves, as `name`. Gives its URL (let go of with the result). */
  function finish(blob: Blob, name: string, announce: string): string {
    url = URL.createObjectURL(blob);
    outName = name;
    show({ done: true });
    downloadBtn.focus();
    say(announce);
    successListeners.forEach((cb) => cb(1));
    return url;
  }

  /** Cancel: the worker is stopped; the file stays, ready to go again. */
  function cancelled(): void {
    failed('cancelled');
    show({ drop: true, file: true });
    runBtn.disabled = false;
    runBtn.focus();
    say('Cancelled');
  }
  cancelBtn.addEventListener('click', () => {
    if (!running) return;
    gen++;
    abort(); // terminates the worker
    cancelled();
  });

  downloadBtn.addEventListener('click', () => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    document.body.append(a);
    a.click();
    a.remove();
  });

  resetBtn.addEventListener('click', () => {
    abort();
    revokeResult();
    clearFile();
    gen++;
    show({ drop: true });
    say('');
    input.focus();
  });

  // --- files: the picker, or a drop anywhere on the page (ignored while working) ---
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = ''; // choosing the same file again must fire `change` again
    if (file) void take(file);
  });
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  let depth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || drop.hidden) return;
    depth++;
    drop.classList.add('is-over');
  });
  document.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      drop.classList.remove('is-over');
    }
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = drop.hidden ? 'none' : 'copy';
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    drop.classList.remove('is-over');
    const file = e.dataTransfer?.files[0];
    if (file && !running && !drop.hidden) void take(file);
  });

  // The browser can't do this at all: say so at once, rather than after a file. Reported once listeners can be added
  // (right after the island mounts), like every other failure the user sees.
  if (!opts.supported) {
    alertText.textContent = opts.deviceCopy;
    show({ alert: true });
    queueMicrotask(() => failed('device'));
  }
  el.dataset.ready = ''; // the island has taken over

  const hooks: VideoHooks = {
    onSuccess: (cb) => void successListeners.push(cb),
    onError: (cb) => void errorListeners.push(cb),
  };
  return {
    hooks,
    say,
    work,
    finish,
    /** For a failure the op finds itself (a trim that can't be made): reported like the rest. */
    failed,
    /** The file read and ready, with what was read of it. */
    current: () => current,
  };
}
