import { h } from './pdf-shell';

// The ↑ ↓ ✕ row controls shared by Merge and JPG to PDF.

interface HasRow {
  li: HTMLLIElement;
}

function tool(label: string, text: string, attr: string, disabled: boolean, onClick: () => void) {
  const b = h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, [attr]: '' }, text);
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

/** The three icon buttons for the row at `index` of `count`. */
export function rowTools(index: number, count: number, on: { up(): void; down(): void; remove(): void }): HTMLElement {
  return h(
    'div',
    { class: 'row-tools' },
    tool('Move up', '↑', 'data-up', index === 0, on.up),
    tool('Move down', '↓', 'data-down', index === count - 1, on.down),
    tool('Remove', '✕', 'data-remove', false, on.remove),
  );
}

/** Move `row` one place, re-render, and keep focus on its same button, unless that just became disabled. */
export function moveRow<T extends HasRow>(rows: T[], row: T, by: -1 | 1, render: () => void): void {
  const i = rows.indexOf(row);
  rows.splice(i, 1);
  rows.splice(i + by, 0, row);
  render();
  const btn = row.li.querySelector<HTMLButtonElement>(by < 0 ? '[data-up]' : '[data-down]')!;
  (btn.disabled ? row.li.querySelector<HTMLButtonElement>(by < 0 ? '[data-down]' : '[data-up]')! : btn).focus();
}

/** Take `row` out, re-render, and move focus to the row that took its place (or `fallback` when none is left). */
export function removeRow<T extends HasRow>(rows: T[], row: T, render: () => void, fallback: HTMLElement): void {
  const i = rows.indexOf(row);
  rows.splice(i, 1);
  render();
  const next = rows[Math.min(i, rows.length - 1)];
  (next ? next.li.querySelector<HTMLButtonElement>('[data-remove]')! : fallback).focus();
}
