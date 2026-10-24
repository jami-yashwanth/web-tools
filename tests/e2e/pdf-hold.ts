import type { Page } from '@playwright/test';

/**
 * Lets a test hold merge/split results and PDF to JPG pages from the PDF worker. While held, a finished job's result (or
 * page) waits for `releaseResults` (all) or `releaseOne` (the next);  page counts pass straight through. Call `installResultHold` before `page.goto`.
 */
export async function installResultHold(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __hold: boolean; __held: (() => void)[]; __release: () => void; __releaseOne: () => void };
    w.__hold = false;
    w.__held = [];
    w.__release = () => {
      w.__hold = false;
      w.__held.splice(0).forEach((f) => f());
    };
    w.__releaseOne = () => w.__held.shift()?.();
    const Base = window.Worker;
    window.Worker = class extends Base {
      set onmessage(fn: ((e: MessageEvent) => void) | null) {
        super.onmessage = (e: MessageEvent) => {
          if (w.__hold && (e.data?.kind === 'page' || (e.data?.kind === 'done' && typeof e.data.result === 'object'))) w.__held.push(() => fn?.call(this, e));
          else fn?.call(this, e);
        };
      }
      get onmessage() {
        return super.onmessage;
      }
    };
  });
}
export const holdResults = (page: Page) => page.evaluate(() => ((window as unknown as { __hold: boolean }).__hold = true));
export const releaseResults = (page: Page) => page.evaluate(() => (window as unknown as { __release: () => void }).__release());
export const releaseOne = (page: Page) => page.evaluate(() => (window as unknown as { __releaseOne: () => void }).__releaseOne());
/** Wait until the page is holding at least `n` messages, so a release can't beat the worker to it. */
export const waitHeld = (page: Page, n: number) => page.waitForFunction((count) => (window as unknown as { __held: unknown[] }).__held.length >= count, n);
