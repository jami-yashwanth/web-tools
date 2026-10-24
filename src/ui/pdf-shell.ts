import type { PdfFail } from '../pdf/types';
import { track } from './track';

// What every PDF island shares (Merge, Split, PDF to JPG, JPG to PDF): the lazy engine and its loading banner, the
// codec-load alert with Try again, the done state, Start over, and the page-wide file drop. File names only ever go in as text.

export type PdfErrorReason = PdfFail | 'range' | 'wrong-type' | 'too-large' | 'device';

const successListeners: ((count: number) => void)[] = [];
const errorListeners: ((reason: PdfErrorReason) => void)[] = [];
/** `cb(count)` runs after each successful job; `count` is the number of output files. */
export function onSuccess(cb: (count: number) => void): void {
  successListeners.push(cb);
}
/** `cb(reason)` runs for each failure the user sees. */
export function onError(cb: (reason: PdfErrorReason) => void): void {
  errorListeners.push(cb);
}
const succeeded = (count: number) => successListeners.forEach((cb) => cb(count));
// Analytics knows a lack of memory as `device`.
const failed = (reason: PdfErrorReason | 'memory') => errorListeners.forEach((cb) => cb(reason === 'memory' ? 'device' : reason));
export { failed, succeeded };

export const COPY: Record<PdfFail, string> = {
  encrypted: 'This PDF is password-protected. Remove the password and try again.',
  corrupt: "We couldn't read this file. It may be damaged or not a PDF.",
  'codec-load': "Couldn't load the PDF tools. Check your connection.",
  memory: 'This tool needs more memory than this device has.',
};
export const NAME_MAX = 40;
const LOADING_DELAY_MS = 300; // a cached engine answers well inside this: don't flash the banner
export const pages = (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`;
export const reasonOf = (err: unknown): PdfFail => (err as { reason?: PdfFail } | null)?.reason ?? 'codec-load';

/** A job that "succeeded" with nothing usable in it (no pages). Shown as a file we couldn't read. */
export class Unusable extends Error {
  readonly reason = 'corrupt' as const;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

export interface Engine {
  /** Load the engine's library ahead of the first real job. Rejects with codec-load if it can't. */
  warm(): Promise<void>;
}

/** Wire one PDF tool island. `load` imports the engine lazily; it runs on hover, focus or the first file. */
export function createShell<E extends Engine>(el: HTMLElement, load: () => Promise<E>) {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  const tool = el.dataset.tool!;
  // Registered before any interaction. Props are only {tool, count} or {tool, reason}.
  onSuccess((count) => track('convert_success', { tool, count }));
  onError((reason) => track('convert_error', { tool, reason }));
  const drop = q('.drop');
  const input = q<HTMLInputElement>('input[type=file]');
  const loading = q('[data-loading]');
  const alert = q('[data-alert]');
  const alertText = q('[data-alert-text]');
  const retryBtn = q<HTMLButtonElement>('[data-retry]');
  const status = q('[data-status]');
  const list = q('[data-list]');
  const runBtn = q<HTMLButtonElement>('[data-run]');
  const done = q('[data-done]');
  const doneName = q('[data-done-name]');
  const doneMeta = q('[data-done-meta]');
  const doneNote = q('[data-done-note]');
  const bar = q<HTMLProgressElement>('[data-progress]');
  const download = q<HTMLAnchorElement>('[data-download]');
  const resetBtn = q<HTMLButtonElement>('[data-reset]');

  // --- engine, loaded lazily; the banner shows only if work waits on it for more than LOADING_DELAY_MS ---
  let engine: Promise<E> | undefined;
  let warmed: Promise<void> | undefined;
  let ready = false;
  let busy = 0;
  let loadingTimer: ReturnType<typeof setTimeout> | undefined;

  function getEngine(): Promise<E> {
    engine ??= load();
    engine.catch(() => (engine = undefined)); // offline: let the next attempt re-import
    return engine;
  }
  function warm(): Promise<void> {
    if (!warmed) {
      const w = getEngine().then((e) => e.warm());
      warmed = w;
      w.then(
        () => {
          ready = true;
          hideLoading();
        },
        () => {
          if (warmed === w) warmed = undefined; // the client has retired the worker: the next warm starts afresh
          hideLoading();
        },
      );
    }
    return warmed;
  }
  function hideLoading(): void {
    clearTimeout(loadingTimer);
    loading.hidden = true;
  }
  /** Run one engine job, with the loading banner while the engine is still on its way. */
  async function job<T>(fn: (e: E) => Promise<T>): Promise<T> {
    busy++;
    if (!ready) {
      clearTimeout(loadingTimer);
      loadingTimer = setTimeout(() => (loading.hidden = ready || busy === 0), LOADING_DELAY_MS);
    }
    try {
      void warm().catch(() => {});
      return await fn(await getEngine());
    } finally {
      if (--busy === 0) hideLoading();
    }
  }

  const preload = () => void warm().catch(() => {});
  drop.addEventListener('pointerenter', preload);
  drop.addEventListener('focusin', preload);

  /** Show the progress bar at `percent`, or hide it with `null`. */
  function progress(percent: number | null): void {
    bar.hidden = percent === null;
    if (percent !== null) bar.value = percent;
  }

  /** Put text in the status region. `visible: false` is for screen readers only, when the screen already shows it. */
  function say(text: string, visible: boolean): void {
    status.textContent = text;
    status.classList.toggle('visually-hidden', !visible);
  }

  // --- shared alert (codec-load with Try again, or a whole-job failure) ---
  let retry: (() => void) | null = null;
  let alertReason: PdfFail | null = null;
  /**
   * Show a failure in the alert and report it once. One outage fails every pending job as codec-load: while its
   * alert is up, later codec-load failures only refresh what Try again does.
   */
  function report(reason: PdfFail, onRetry: () => void, text = COPY[reason]): void {
    const repeat = reason === 'codec-load' && alertReason === 'codec-load';
    if (!repeat) failed(reason);
    alertText.textContent = text;
    alertReason = reason;
    retry = reason === 'codec-load' ? onRetry : null;
    retryBtn.hidden = !retry;
    alert.hidden = false;
  }
  function hideAlert(): void {
    alert.hidden = true;
    alertReason = null;
    retry = null;
  }
  retryBtn.addEventListener('click', () => {
    const r = retry;
    hideAlert();
    r?.();
  });

  // --- done state ---
  let generation = 0; // bumped by Start over and by replacing the file: late results from before are dropped
  let doneUrl: string | undefined;
  let clearTool: () => void = () => {};
  function showDone(blob: Blob, fileName: string, label: string, name: string, meta: string, announce: string, note = ''): void {
    if (doneUrl) URL.revokeObjectURL(doneUrl);
    doneUrl = URL.createObjectURL(blob);
    download.href = doneUrl;
    download.download = fileName;
    download.textContent = label;
    doneName.textContent = name;
    doneName.hidden = !name;
    doneMeta.textContent = meta;
    doneMeta.hidden = !meta;
    doneNote.textContent = note;
    doneNote.hidden = !note;
    progress(null);
    say(announce, false);
    list.hidden = true;
    drop.hidden = true;
    done.hidden = false;
  }
  /** Back to an empty tool. Revokes every object URL this page made. */
  function startOver(): void {
    generation++;
    if (doneUrl) URL.revokeObjectURL(doneUrl);
    doneUrl = undefined;
    download.removeAttribute('href');
    done.hidden = true;
    say('', true);
    hideAlert();
    progress(null);
    clearTool();
    drop.hidden = false;
    drop.classList.remove('drop-compact');
    list.hidden = true;
    input.focus();
  }
  resetBtn.addEventListener('click', startOver);

  let busyRunning = false; // a job is running: drops are ignored until it is done
  /** Run a job: show `running`, hide the inputs, and on failure bring them back with the alert. */
  async function runJob(
    running: string,
    work: (gen: number) => Promise<void>,
    again: () => void,
    /** Words for this failure, when the shared copy for its reason isn't the whole story. */
    explain?: (err: unknown) => string | undefined,
  ): Promise<void> {
    const gen = generation;
    hideAlert();
    busyRunning = true;
    list.hidden = true;
    drop.hidden = true;
    say(running, true);
    try {
      await work(gen);
    } catch (err) {
      if (gen !== generation) return;
      progress(null);
      say('', true);
      list.hidden = false;
      drop.hidden = false;
      report(reasonOf(err), again, explain?.(err));
    } finally {
      busyRunning = false;
    }
  }

  /** Adding files: the picker, or a drop anywhere on the page. */
  function wire(add: (files: File[]) => void, clear: () => void): void {
    clearTool = clear;
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      input.value = ''; // choosing the same file again must fire `change` again
      if (files.length) add(files);
    });
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    let depth = 0;
    document.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      drop.classList.add('is-over');
      preload();
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
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      drop.classList.remove('is-over');
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length && done.hidden && !busyRunning) add(files);
    });
  }

  return {
    q,
    el,
    drop,
    input,
    list,
    runBtn,
    job,
    say,
    progress,
    report,
    hideAlert,
    showDone,
    runJob,
    wire,
    get generation() {
      return generation;
    },
    bump: () => void generation++,
  };
}
