import type { Page } from '@playwright/test';

// The AI island's panel (consent, downloading, working) and Compress video's working panel can pass in a blink when
// files are local. These record every text it shows while it is on screen, so a test can check a state was shown
// after the fact.

type Recorded = { seen: string[]; extra: string[] };

/** Start recording on every page load. Call before page.goto. */
export async function recordPanel(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const rec = window as unknown as Recorded;
    rec.seen = [];
    rec.extra = [];
    addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        const panel = document.querySelector<HTMLElement>('[data-ai-panel], [data-video-panel]');
        if (!panel || panel.hidden) return;
        const t = panel.querySelector('p')?.textContent;
        if (t) rec.seen.push(t);
        // The panel's notes and live output, while shown.
        for (const el of panel.querySelectorAll<HTMLElement>('.note, [data-ai-live]')) {
          const x = el.textContent;
          if (x && !el.hidden && rec.extra.at(-1) !== x) rec.extra.push(x);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
  });
}

/** Every panel text recorded on this page load so far. */
export const panelSeen = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as Recorded).seen);

/** Every note and live output the panel showed on this page load so far. */
export const panelExtraSeen = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as Recorded).extra);

/** Forget what was recorded so far. */
export const clearPanelSeen = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as Recorded).seen = [];
    (window as unknown as Recorded).extra = [];
  });
