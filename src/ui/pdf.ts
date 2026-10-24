import type { PdfEngine } from '../pdf/client';
import { parseRanges } from '../pdf/ranges';
import type { PdfFail, PdfOut } from '../pdf/types';
import { formatBytes, middleTruncate } from './format';
import { moveRow, removeRow, rowTools } from './pdf-rows';
import { COPY, createShell, failed, h, NAME_MAX, pages, reasonOf, succeeded, Unusable } from './pdf-shell';

// Enhances the static markup from PdfTool.astro for Merge and Split. The engine (worker + pdf-lib) is imported on
// drop-zone hover, focus or the first file, which keeps the page inside the 15 KB budget.

export { onError, onSuccess, type PdfErrorReason } from './pdf-shell';

export function mount(el: HTMLElement): void {
  const isMerge = el.dataset.op === 'merge';
  const shell = createShell<PdfEngine>(el, () => import('../pdf/client').then(({ createPdfEngine }) => createPdfEngine()));
  const { q, drop, input, list, runBtn, job, say, report, hideAlert, showDone, runJob } = shell;

  /** The job produced nothing usable (no pages): treat it as a file we couldn't read. */
  const empty = (outs: PdfOut[]) => !outs.length || outs.some((o) => o.pages === 0);
  const pdfBlob = (o: PdfOut) => new Blob([o.bytes as BlobPart], { type: 'application/pdf' });

  const { add, clear } = isMerge ? mountMerge() : mountSplit();
  shell.wire(add, clear);

  // ======================= Merge =======================
  function mountMerge() {
    type State = { kind: 'reading' } | { kind: 'counted'; pages: number } | { kind: 'failed'; reason: PdfFail };
    interface Row {
      id: string;
      file: File;
      state: State;
      li: HTMLLIElement;
    }
    const ul = q('[data-rows]');
    const hint = q('[data-hint]');
    let rows: Row[] = [];
    let nextId = 0;

    function count(row: Row): void {
      row.state = { kind: 'reading' };
      const gen = shell.generation;
      job((e) => e.count(row.id, row.file)).then(
        (n) => settle(row, gen, n > 0 ? { kind: 'counted', pages: n } : { kind: 'failed', reason: 'corrupt' }),
        (err) => settle(row, gen, { kind: 'failed', reason: reasonOf(err) }),
      );
    }
    function settle(row: Row, gen: number, state: State): void {
      if (gen !== shell.generation || !rows.includes(row)) return; // removed, or Start over, meanwhile
      row.state = state;
      if (state.kind === 'failed') {
        if (state.reason === 'codec-load') report('codec-load', retryCounts);
        else {
          failed(state.reason); // a fact about this one file: reported per file
          say(`${row.file.name}: ${COPY[state.reason]}`, false);
        }
      }
      render();
    }
    function retryCounts(): void {
      for (const row of rows) if (row.state.kind === 'failed' && row.state.reason === 'codec-load') count(row);
      render();
    }

    function add(files: File[]): void {
      for (const file of files) {
        const row: Row = { id: `m${nextId++}`, file, state: { kind: 'reading' }, li: h('li', { class: 'row' }) };
        rows.push(row);
        count(row);
      }
      render();
    }
    function clear(): void {
      rows = [];
      ul.replaceChildren();
    }

    function renderRow(row: Row, i: number): void {
      const s = row.state;
      const meta =
        s.kind === 'reading'
          ? h('span', { class: 'size' }, 'Reading…')
          : s.kind === 'counted'
            ? h('span', { class: 'size' }, pages(s.pages))
            : s.reason === 'codec-load'
              ? h('span', { class: 'size' })
              : h('span', { class: 'error' }, COPY[s.reason]);
      row.li.className = `row row-${s.kind}`;
      row.li.replaceChildren(
        h('div', { class: 'info' }, h('span', { class: 'name', title: row.file.name }, middleTruncate(row.file.name, NAME_MAX)), meta),
        rowTools(i, rows.length, {
          up: () => moveRow(rows, row, -1, render),
          down: () => moveRow(rows, row, 1, render),
          remove: () => {
            // Dropping the last row that failed to load the engine clears its alert.
            const rest = rows.filter((r) => r !== row);
            if (!rest.some((r) => r.state.kind === 'failed' && r.state.reason === 'codec-load')) hideAlert();
            removeRow(rows, row, render, input);
          },
        }),
      );
    }
    function render(): void {
      rows.forEach(renderRow);
      ul.replaceChildren(...rows.map((r) => r.li));
      list.hidden = rows.length === 0;
      drop.classList.toggle('drop-compact', rows.length > 0);
      hint.hidden = rows.length !== 1;
      runBtn.disabled = rows.length < 2 || !rows.every((r) => r.state.kind === 'counted');
    }

    function run(): Promise<void> {
      const files = rows.map((r) => r.file);
      return runJob(
        `Merging ${files.length} files…`,
        async (gen) => {
          const out = await job((e) => e.merge(files));
          if (gen !== shell.generation) return;
          if (empty([out])) throw new Unusable();
          const meta = `${pages(out.pages)} · ${formatBytes(out.bytes.byteLength)}`;
          showDone(pdfBlob(out), out.name, 'Download', out.name, meta, `${out.name} ready, ${meta}`);
          succeeded(1);
        },
        () => void run(),
      );
    }
    runBtn.addEventListener('click', () => void run());

    return { add, clear };
  }

  // ======================= Split =======================
  function mountSplit() {
    const nameEl = q('[data-name]');
    const metaEl = q('[data-meta]');
    const fileError = q('[data-file-error]');
    const options = [...el.querySelectorAll<HTMLElement>('[data-options]')];
    const modes = [...el.querySelectorAll<HTMLInputElement>('[data-mode]')];
    const rangesInput = q<HTMLInputElement>('[data-ranges]');
    const rangeError = q('[data-range-error]');
    let current: { file: File; pages?: number } | undefined;
    let nextId = 0;

    const extracting = () => modes.find((m) => m.checked)?.value === 'ranges';
    for (const m of modes)
      m.addEventListener('change', () => {
        rangesInput.disabled = !extracting();
        rangeError.hidden = true;
        if (extracting()) rangesInput.focus();
      });
    rangesInput.addEventListener('input', () => (rangeError.hidden = true));
    rangesInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void run();
    });

    function count(): void {
      const target = current!;
      const gen = shell.generation;
      metaEl.textContent = 'Reading…';
      runBtn.disabled = true;
      job((e) => e.count(`s${nextId++}`, target.file)).then(
        (n) => {
          if (gen !== shell.generation) return;
          if (n > 0) loaded(target, n);
          else fail('corrupt');
        },
        (err) => gen === shell.generation && fail(reasonOf(err)),
      );
    }
    function loaded(target: { file: File; pages?: number }, n: number): void {
      target.pages = n;
      metaEl.textContent = pages(n);
      runBtn.disabled = false;
    }
    function fail(reason: PdfFail): void {
      metaEl.textContent = '';
      if (reason === 'codec-load') {
        report('codec-load', count);
        return;
      }
      failed(reason);
      fileError.textContent = COPY[reason];
      fileError.hidden = false;
      options.forEach((o) => (o.hidden = true));
    }

    /** A new PDF replaces the current one. */
    function add(files: File[]): void {
      shell.bump();
      hideAlert();
      current = { file: files[0]! };
      nameEl.textContent = middleTruncate(current.file.name, NAME_MAX);
      nameEl.title = current.file.name;
      fileError.hidden = true;
      rangeError.hidden = true;
      options.forEach((o) => (o.hidden = false));
      list.hidden = false;
      drop.classList.add('drop-compact');
      count();
    }
    function clear(): void {
      current = undefined;
      modes[0]!.checked = true;
      rangesInput.value = '';
      rangesInput.disabled = true;
      rangeError.hidden = true;
      fileError.hidden = true;
    }

    async function run(): Promise<void> {
      const target = current;
      if (!target?.pages || runBtn.disabled) return;
      let mode: Parameters<PdfEngine['split']>[1] = { kind: 'every' };
      if (extracting()) {
        const ranges = parseRanges(rangesInput.value, target.pages);
        if (ranges instanceof RangeError) {
          rangeError.textContent = `Pages must be between 1 and ${target.pages}, like 1-3, 5.`;
          rangeError.hidden = false;
          failed('range');
          rangesInput.focus();
          return;
        }
        mode = { kind: 'ranges', ranges };
      }
      await runJob(
        'Splitting…',
        async (gen) => {
          const outs = await job((e) => e.split(target.file, mode));
          if (gen !== shell.generation) return;
          if (empty(outs)) throw new Unusable();
          if (outs.length > 1) {
            const { zipFiles } = await import('./zip');
            const zip = await zipFiles(outs.map((o) => ({ name: o.name, blob: pdfBlob(o) })));
            if (gen !== shell.generation) return;
            const base = target.file.name.replace(/\.pdf$/i, '') || 'document';
            const zipName = `${base}-pages.zip`;
            showDone(zip, zipName, 'Download all (ZIP)', '', `${outs.length} files`, `${zipName} ready, ${outs.length} files`);
          } else {
            const o = outs[0]!;
            showDone(pdfBlob(o), o.name, 'Download', o.name, '', `${o.name} ready, ${pages(o.pages)}`);
          }
          succeeded(outs.length);
        },
        () => void run(),
      );
    }
    runBtn.addEventListener('click', () => void run());

    return { add, clear };
  }
}
