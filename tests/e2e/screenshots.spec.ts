import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { holdResults, installResultHold, releaseOne, releaseResults, waitHeld } from './pdf-hold';
import { WHISPER_FILES } from '../../src/ai/whisper/files';
import { modelBytes, routeModels } from './models';
import { tone, wav } from './wav';

// Not an assertion suite: captures every spec §5 state for a human design review.
// Output: review/screenshots/<page>-<state>-<width>.png (git-ignored). Chromium only.
// Run: npx playwright test tests/e2e/screenshots.spec.ts --project=chromium

test.skip(({ browserName }) => browserName !== 'chromium', 'screenshots are reviewed in one engine');
test.beforeEach(({ context }) => context.route('https://plausible.io/**', (r) => r.fulfill({ status: 202, body: '' })));

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];
const fixture = (name: string) => `tests/fixtures/${name}`;
const heic = (file: string, name = file) => ({ name, mimeType: 'image/heic', buffer: readFileSync(fixture(file)) });
const doneRows = (page: Page) => page.locator('[data-rows] > li.row-done');
const LONG_NAME = 'IMG_20261023_142233_holiday_beach_sunset_family_final_v2.heic';

async function choose(page: Page, ...names: string[]) {
  await page.locator('[data-tool] input[type=file]').setInputFiles(names.map(fixture));
}

async function hold(page: Page, pattern: RegExp) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.context().route(pattern, async (route: Route) => {
    await gate;
    await route.continue();
  });
  return release;
}
const HEIC_CODEC = /libheif-bundle-[^/]*\.js$/;
const pdf = (page: Page, ...names: string[]) =>
  page.locator('[data-kind="pdf"] input[type=file]').setInputFiles(names.map((n) => fixture(`pdf/${n}`)));
const pdfRows = (page: Page) => page.locator('[data-rows] > li');
const btn = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
// The JWT shots pin the clock and zone so "Expires … (in 1 hour)" reads the same on every run.
const NOW = new Date('2026-10-24T12:00:00Z');
const at = (offsetSeconds: number) => Math.floor(NOW.getTime() / 1000) + offsetSeconds;
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const jwt = (payload: object) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.c2lnbmF0dXJl`;
const SAMPLE_JSON = JSON.stringify({
  id: 'ord_2041',
  status: 'paid',
  customer: { name: 'Ana Lima', email: 'ana@example.com' },
  items: [
    { sku: 'MUG-01', qty: 2, price: 12.5 },
    { sku: 'TEE-M', qty: 1, price: 24 },
  ],
  total: 49,
  shipped: false,
});

// --- round 3 (AI, PDF images, video) ---

/**
 * Freeze an AI or video worker's progress for a shot. Call before page.goto; then `freezeAt(page, stage, fraction)`
 * before the action. The first progress message of that stage reaches the page with done set to `fraction` of its
 * total (so the shown number is the same on every run), and every message after it is held back for good: the state
 * stays on screen. `partial`: wait for a message that carries live output (the transcript so far).
 */
async function installFreeze(page: Page) {
  await page.addInitScript(() => {
    type Freeze = { stage: string; fraction: number; partial: boolean } | null;
    const w = window as unknown as { __freeze: Freeze; __frozen: boolean };
    w.__freeze = null;
    w.__frozen = false;
    const Base = window.Worker;
    window.Worker = class extends Base {
      set onmessage(fn: ((e: MessageEvent) => void) | null) {
        super.onmessage = (e: MessageEvent) => {
          if (w.__frozen) return;
          const f = w.__freeze;
          const d = e.data;
          if (f && d?.kind === 'progress' && d.stage === f.stage && (!f.partial || d.partial?.segments?.length > 0) && (f.stage !== 'download' || d.done < d.total)) {
            w.__frozen = true;
            const data = { ...d, done: Math.round(d.total * f.fraction) };
            fn?.call(this, new MessageEvent('message', { data }));
            return;
          }
          fn?.call(this, e);
        };
      }
      get onmessage() {
        return super.onmessage;
      }
    };
  });
}
const freezeAt = (page: Page, stage: 'download' | 'work', fraction: number, partial = false) =>
  page.evaluate((f) => ((window as unknown as { __freeze: unknown }).__freeze = f), { stage, fraction, partial });
const unfreeze = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __frozen: boolean; __freeze: unknown };
    w.__frozen = false;
    w.__freeze = null;
  });
const frozen = (page: Page) => page.waitForFunction(() => (window as unknown as { __frozen: boolean }).__frozen);
/** Seek the preview to its first frame and wait until that frame is decoded and on screen (no loading spinner). */
const framePainted = (video: Locator) =>
  video.evaluate(
    (v: HTMLVideoElement) =>
      new Promise<void>((resolve) => {
        const go = () => {
          // A frame callback may never come if the frame is already on screen (seen on CI runners), so cap the wait.
          const painted = new Promise<void>((r) => {
            if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => r());
            else r();
            setTimeout(r, 2000);
          });
          const seeked = new Promise<void>((r) => v.addEventListener('seeked', () => r(), { once: true }));
          // Seeking to the current time may not fire 'seeked', so always seek somewhere new.
          v.currentTime = v.currentTime === 0.01 ? 0.02 : 0.01;
          void Promise.all([painted, seeked]).then(() => resolve());
        };
        if (v.readyState >= 1) go();
        else v.addEventListener('loadedmetadata', go, { once: true });
      }),
  );
const aiInput = (page: Page) => page.locator('[data-kind="ai"] input[type=file]');
const videoInput = (page: Page) => page.locator('[data-kind="video"] input[type=file]');
const aiPanelText = (page: Page) => page.locator('[data-ai-panel] > p').first();
const PHOTO = fixture('photo.jpg');
const WHISPER_SIZE = (url: string) => {
  const name = Object.keys(WHISPER_FILES).find((f) => url.endsWith(`/${f}`));
  if (!name) throw new Error(`unexpected model request ${url}`);
  return WHISPER_FILES[name]!.bytes;
};
const toneWav = (name: string, seconds: number) => ({ name, mimeType: 'audio/wav', buffer: wav([tone(seconds, 8_000)], 8_000, 8) });
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
/** What the device reports: memory 8 GB (so Upscale offers 4×), or a phone (2× only). */
const device = (page: Page, phone: boolean) =>
  page.addInitScript(
    ([phone, ua]) => {
      const nav = Navigator.prototype;
      Object.defineProperty(nav, 'deviceMemory', { get: () => 8, configurable: true });
      if (phone) {
        Object.defineProperty(nav, 'userAgent', { get: () => ua, configurable: true });
        Object.defineProperty(nav, 'userAgentData', { get: () => ({ mobile: true }), configurable: true });
      }
    },
    [phone, IPHONE] as const,
  );

for (const vp of VIEWPORTS) {
  test.describe(`${vp.width}px`, () => {
    test.use({ viewport: vp });
    const shot = async (page: Page, name: string, fullPage = false) => {
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `review/screenshots/${name}-${vp.width}.png`, fullPage, animations: 'disabled' });
    };

    test('home', async ({ page }) => {
      await page.goto('/');
      await shot(page, 'home-grouped', true);
      await page.locator('#filter').fill('pdf');
      await expect(page.locator('.category:not([hidden])')).toHaveCount(1);
      await shot(page, 'home-filtered');
      await page.locator('#filter').fill('zzzz');
      await expect(page.locator('#no-match')).toBeVisible();
      await shot(page, 'home-no-match');
    });

    test('heic: empty, hover, focus, drag-over, options', async ({ page }) => {
      await page.goto('/heic-to-jpg/');
      await shot(page, 'heic-to-jpg-empty', true);
      await shot(page, 'heic-to-jpg-empty-fold');
      await page.locator('label.btn').hover();
      // Wait out the colour transition, then capture with the pointer still on the button.
      await expect(page.locator('label.btn')).toHaveCSS('background-color', 'rgb(8, 69, 54)');
      await page.screenshot({ path: `review/screenshots/heic-to-jpg-hover-${vp.width}.png` });
      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab'); // nav link
      await page.keyboard.press('Tab'); // file input inside the Choose photos label
      await expect(page.locator('[data-tool] input[type=file]')).toBeFocused();
      await shot(page, 'heic-to-jpg-focus');
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'a.heic'));
        document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
      });
      await expect(page.locator('.drop')).toHaveClass(/is-over/);
      // At 390 the drop zone is a plain button with no drag-over look, so only desktop gets this shot.
      if (vp.width > 600) {
        await expect(page.locator('.drop')).toHaveCSS('background-color', 'rgb(216, 234, 225)');
        await shot(page, 'heic-to-jpg-drag-over');
      }
      await page.reload();
      await page.locator('details.settings summary').click();
      await shot(page, 'heic-to-jpg-options-open');
    });

    test('heic: loading codec', async ({ page }) => {
      const release = await hold(page, HEIC_CODEC);
      await page.goto('/heic-to-jpg/');
      await choose(page, 'rotated-6.heic', 'multi.heic');
      await expect(page.getByText('Getting the converter ready…')).toBeVisible();
      await shot(page, 'heic-to-jpg-loading');
      release();
    });

    test('heic: processing', async ({ page }) => {
      await page.goto('/heic-to-jpg/');
      await choose(page, 'rotated-6.heic'); // warm the codec so the banner stays away
      await expect(doneRows(page)).toHaveCount(1);
      await page.getByRole('button', { name: 'Convert more' }).click();
      await page.locator('[data-tool] input[type=file]').setInputFiles([
        heic('iphone-12mp.heic'),
        heic('multi.heic'),
        heic('rotated-6.heic', LONG_NAME),
        heic('rotated-6.heic'),
      ]);
      await expect(page.locator('[data-status]')).toHaveText(/Converting \d of 4/);
      await shot(page, 'heic-to-jpg-processing');
    });

    test('heic: done, long names, disabled ZIP', async ({ page }) => {
      await page.goto('/heic-to-jpg/');
      await page.locator('[data-tool] input[type=file]').setInputFiles([
        heic('iphone-12mp.heic'),
        heic('rotated-6.heic', LONG_NAME),
        heic('multi.heic'),
      ]);
      await expect(doneRows(page)).toHaveCount(3);
      await shot(page, 'heic-to-jpg-done');
      await page.locator('[data-zip]').evaluate((b: HTMLButtonElement) => (b.disabled = true)); // as while zipping
      await shot(page, 'heic-to-jpg-zip-disabled');
    });

    test('heic: wrong type, corrupt, mixed with done', async ({ page }) => {
      await page.goto('/heic-to-jpg/');
      await choose(page, 'alpha.png');
      await expect(page.getByText('This is a PNG, not a HEIC photo.')).toBeVisible();
      await shot(page, 'heic-to-jpg-wrong-type');
      await page.getByRole('button', { name: 'Convert more' }).click();
      await choose(page, 'truncated.heic');
      await expect(page.getByText("We couldn't read this file.", { exact: false })).toBeVisible();
      await shot(page, 'heic-to-jpg-corrupt');
      await page.getByRole('button', { name: 'Convert more' }).click();
      await choose(page, 'iphone-12mp.heic', 'alpha.png', 'truncated.heic', 'rotated-6.heic');
      await expect(doneRows(page)).toHaveCount(2);
      await expect(page.getByRole('button', { name: 'Convert more' })).toBeVisible();
      await shot(page, 'heic-to-jpg-mixed');
    });

    test('heic: codec load failed', async ({ page }) => {
      await page.context().route(HEIC_CODEC, (route) => route.abort());
      await page.goto('/heic-to-jpg/');
      await choose(page, 'rotated-6.heic');
      await expect(page.getByText("Couldn't load the converter. Check your connection.")).toBeVisible();
      await shot(page, 'heic-to-jpg-codec-failed');
    });

    test('heic: out of memory', async ({ page }) => {
      await page.context().route(/\/worker-[^/]*\.js$/, (route) =>
        route.fulfill({ contentType: 'text/javascript', body: 'self.onmessage = (e) => { self.postMessage({ kind: "progress", id: e.data.job.id, stage: "decoding" }); throw new Error("boom"); };' }),
      );
      await page.goto('/heic-to-jpg/');
      await choose(page, 'rotated-6.heic');
      await expect(page.getByText('Ran out of memory')).toBeVisible();
      await shot(page, 'heic-to-jpg-oom');
    });

    test('compress: slider, too large', async ({ page }) => {
      test.slow(); // decodes a 63 MP JPEG
      await page.goto('/compress-image/');
      await shot(page, 'compress-image-empty', true);
      // No HEIC fixture is over the 50 MP cap, so the too-large row is captured on Compress.
      await choose(page, 'huge-63mp.jpg');
      await expect(page.getByText('This image is too large for your device to convert (63 MP).')).toBeVisible();
      await shot(page, 'compress-image-too-large');
    });

    test('merge-pdf: empty, one file, list, merging, done, encrypted', async ({ page }) => {
      await installResultHold(page);
      await page.goto('/merge-pdf/');
      await shot(page, 'merge-pdf-empty', true);
      await pdf(page, 'three-pages.pdf');
      await expect(pdfRows(page).first()).toContainText('3 pages');
      await expect(page.getByText('Add at least one more PDF to merge.')).toBeVisible();
      await shot(page, 'merge-pdf-one-file');
      await pdf(page, 'two-pages.pdf');
      await expect(pdfRows(page).last()).toContainText('2 pages');
      await expect(btn(page, 'Merge PDFs')).toBeEnabled();
      await shot(page, 'merge-pdf-list');
      await holdResults(page);
      await btn(page, 'Merge PDFs').click();
      await expect(page.getByText('Merging 2 files…')).toBeVisible();
      await shot(page, 'merge-pdf-merging');
      await releaseResults(page);
      await expect(page.getByText(/^5 pages · \d+ KB$/)).toBeVisible();
      await shot(page, 'merge-pdf-done');
      await btn(page, 'Start over').click();
      await pdf(page, 'three-pages.pdf', 'encrypted.pdf', 'two-pages.pdf');
      await expect(pdfRows(page).nth(1)).toContainText('This PDF is password-protected.');
      await expect(pdfRows(page).last()).toContainText('2 pages');
      await shot(page, 'merge-pdf-encrypted');
    });

    test('split-pdf: loaded, invalid range, done every page', async ({ page }) => {
      await installResultHold(page);
      await page.goto('/split-pdf/');
      await pdf(page, 'three-pages.pdf');
      await expect(page.getByText('3 pages', { exact: true })).toBeVisible();
      await shot(page, 'split-pdf-loaded');
      await page.getByLabel('Extract pages:').check();
      await page.getByPlaceholder('1-3, 5').fill('9');
      await btn(page, 'Split PDF').click();
      await expect(page.getByText('Pages must be between 1 and 3, like 1-3, 5.')).toBeVisible();
      await page.mouse.click(0, 0); // drop focus so the shot shows the error, not the ring
      await shot(page, 'split-pdf-invalid-range');
      await page.getByLabel('Every page as a separate file').check();
      await btn(page, 'Split PDF').click();
      await expect(page.getByText('3 files', { exact: true })).toBeVisible();
      await shot(page, 'split-pdf-done-every');
    });

    test('split-pdf: empty, damaged', async ({ page }) => {
      await page.goto('/split-pdf/');
      await shot(page, 'split-pdf-empty', true);
      await pdf(page, 'not-a.pdf');
      await expect(page.getByText("We couldn't read this file. It may be damaged or not a PDF.")).toBeVisible();
      await shot(page, 'split-pdf-damaged');
    });

    test('merge-pdf: codec load failed', async ({ page }) => {
      await page.context().route(/\/_astro\/pdf-lib-[^/]*\.js$/, (route) => route.abort());
      await page.goto('/merge-pdf/');
      await pdf(page, 'three-pages.pdf', 'two-pages.pdf');
      await expect(page.getByText("Couldn't load the PDF tools. Check your connection.")).toBeVisible();
      await expect(page.getByText('Reading…')).toHaveCount(0);
      await shot(page, 'merge-pdf-codec-failed');
    });

    test('json-formatter: empty, formatted, invalid', async ({ page }) => {
      await page.goto('/json-formatter/');
      await shot(page, 'json-formatter-empty', true);
      await page.getByLabel('JSON', { exact: true }).fill(SAMPLE_JSON);
      await btn(page, 'Format').click();
      await expect(page.locator('pre[data-results]')).toContainText('"shipped": false');
      await shot(page, 'json-formatter-formatted');
      await page.getByLabel('JSON', { exact: true }).fill('{\n  "id": "ord_2041",\n  "total": 49\n  "shipped": false\n}');
      await btn(page, 'Format').click();
      await expect(page.locator('[data-status]')).toHaveText(/^Invalid JSON at line 4/);
      await page.locator('#json-in').blur();
      await shot(page, 'json-formatter-invalid');
    });

    test('base64: filled, invalid', async ({ page }) => {
      await page.goto('/base64-encode-decode/');
      await page.getByLabel('Text', { exact: true }).fill('Hello, world! Héllo 👋');
      await expect(page.getByLabel('Base64', { exact: true })).not.toHaveValue('');
      await page.getByLabel('Text', { exact: true }).blur();
      await shot(page, 'base64-encode-decode-filled');
      await page.getByLabel('Base64', { exact: true }).fill('SGVsbG8sIHdvcmxk!!');
      await expect(page.getByText("This isn't valid Base64.")).toBeVisible();
      await page.getByLabel('Base64', { exact: true }).blur();
      await shot(page, 'base64-encode-decode-invalid');
    });

    test.describe('jwt', () => {
      test.use({ timezoneId: 'UTC' });
      test('jwt-decoder: decoded, expired, malformed', async ({ page }) => {
        await page.clock.setFixedTime(NOW);
        await page.goto('/jwt-decoder/');
        const input = page.getByLabel('Token');
        await input.fill(jwt({ sub: '42', name: 'Ana Lima', role: 'admin', iat: at(-3600), nbf: at(-3600), exp: at(3600) }));
        await expect(page.getByText('Expires 24 Oct 2026, 13:00 (in 1 hour)')).toBeVisible();
        await input.blur();
        await shot(page, 'jwt-decoder-decoded');
        await input.fill(jwt({ sub: '42', iat: at(-90000), exp: at(-7200) }));
        await expect(page.getByText('Expired 2 hours ago', { exact: true })).toBeVisible();
        await input.blur();
        await shot(page, 'jwt-decoder-expired');
        await input.fill('not.a-jwt');
        await expect(page.getByText("This doesn't look like a JWT.", { exact: false })).toBeVisible();
        await input.blur();
        await shot(page, 'jwt-decoder-malformed');
      });
    });

    test('qr-code-generator: empty, filled, too long', async ({ page }) => {
      await page.goto('/qr-code-generator/');
      await shot(page, 'qr-code-generator-empty', true);
      const input = page.getByLabel('Text or URL');
      await input.fill('https://example.com/menu');
      await expect(page.locator('.qr-preview.has-code')).toBeVisible();
      await expect(btn(page, 'Download PNG')).toBeEnabled();
      await input.blur();
      await shot(page, 'qr-code-generator-filled');
      await input.fill('a'.repeat(3000));
      await expect(page.locator('[data-status]')).toHaveText(/^Too much text for a QR code/);
      await input.blur();
      await shot(page, 'qr-code-generator-too-long');
    });

    test('remove-background: empty, downloading, working, done, white, large photo', async ({ page }) => {
      test.slow();
      await installFreeze(page);
      await page.goto('/remove-background/');
      await shot(page, 'remove-background-empty', true);
      const models = await routeModels(page, await modelBytes(page));
      // Downloading: held at 42% of the first-use download.
      await freezeAt(page, 'download', 0.42);
      await aiInput(page).setInputFiles(PHOTO);
      await frozen(page);
      await expect(aiPanelText(page)).toHaveText(/^Downloading the AI model… \d+ of 19 MB, one time only$/);
      await shot(page, 'remove-background-downloading');
      // Working: a fresh page load (the model is now cached once this run ends, so no download first).
      await page.getByRole('button', { name: 'Cancel' }).click();
      await unfreeze(page);
      await aiInput(page).setInputFiles(PHOTO);
      await expect(page.getByRole('button', { name: 'Download PNG' })).toBeEnabled({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Start over' }).click();
      await freezeAt(page, 'work', 0.64);
      await aiInput(page).setInputFiles(PHOTO);
      await frozen(page);
      await expect(aiPanelText(page)).toHaveText(/^Removing background… \d+%$/);
      await shot(page, 'remove-background-working');
      await page.reload();
      await routeModels(page, await modelBytes(page));
      await aiInput(page).setInputFiles(PHOTO);
      await expect(page.getByRole('button', { name: 'Download PNG' })).toBeEnabled({ timeout: 60_000 });
      await expect(page.getByRole('slider', { name: 'Compare before and after' })).toBeVisible();
      await shot(page, 'remove-background-done', true);
      // Keyboard focus on the handle, over the photo (transparent background: the subject is behind the grip).
      const slider = page.getByRole('slider', { name: 'Compare before and after' });
      await slider.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(slider).toHaveAttribute('aria-valuenow', '45');
      await shot(page, 'remove-background-slider-focus');
      await slider.blur();
      await page.getByRole('radio', { name: 'White' }).check();
      await expect(page.getByRole('button', { name: 'Download PNG' })).toBeEnabled();
      await page.getByRole('radio', { name: 'White' }).blur();
      await shot(page, 'remove-background-done-white', true);
      await page.getByRole('button', { name: 'Start over' }).click();
      await aiInput(page).setInputFiles(fixture('bg-26mp.png'));
      await expect(page.getByText('Large photo: processed at 25 MP.', { exact: true })).toBeVisible({ timeout: 60_000 });
      await shot(page, 'remove-background-too-large-note', true);
      expect(models.requests).toBeGreaterThan(0);
    });

    test('image-to-text: empty, working, done, low confidence, no text', async ({ page }) => {
      test.slow();
      await installFreeze(page);
      await page.goto('/image-to-text/');
      await shot(page, 'image-to-text-empty', true);
      const box = page.getByRole('textbox', { name: 'Text' });
      // Warm the language file, so the working shot is not the download.
      await aiInput(page).setInputFiles(fixture('ocr/hello.png'));
      await expect(box).toHaveValue(/quick brown fox/i, { timeout: 60_000 });
      await box.blur();
      await shot(page, 'image-to-text-done', true);
      await page.getByRole('button', { name: 'Start over' }).click();
      await aiInput(page).setInputFiles(fixture('ocr/low-confidence.png'));
      await expect(page.getByText('Some text may be wrong. Check it before using.', { exact: true })).toBeVisible({ timeout: 60_000 });
      await shot(page, 'image-to-text-low-confidence', true);
      await page.getByRole('button', { name: 'Start over' }).click();
      await aiInput(page).setInputFiles(fixture('ocr/blank.png'));
      await expect(page.getByText("We couldn't find any text in this image.", { exact: true })).toBeVisible({ timeout: 60_000 });
      await shot(page, 'image-to-text-no-text', true);
      await page.getByRole('button', { name: 'Start over' }).click();
      await freezeAt(page, 'work', 0.38);
      await aiInput(page).setInputFiles(fixture('ocr/hello.png'));
      await frozen(page);
      await expect(aiPanelText(page)).toHaveText(/^Reading text… \d+%$/);
      await shot(page, 'image-to-text-working');
    });

    test('upscale-image: empty, done, too large', async ({ page }) => {
      test.slow();
      await device(page, false);
      await page.goto('/upscale-image/');
      await expect(page.locator('[data-scale-4]')).toBeVisible();
      await shot(page, 'upscale-image-empty', true);
      await routeModels(page, await modelBytes(page));
      await page.getByRole('radio', { name: '4×' }).check();
      await aiInput(page).setInputFiles(PHOTO);
      await expect(page.getByRole('alert').locator('.error')).toHaveText('Upscaled image would be too large. Try 2×.');
      await page.getByRole('radio', { name: '4×' }).blur();
      await shot(page, 'upscale-image-too-large', true);
      await page.getByRole('radio', { name: '2×' }).check();
      await aiInput(page).setInputFiles(fixture('rotated-6.jpg'));
      await expect(page.getByRole('button', { name: 'Download PNG' })).toBeEnabled({ timeout: 60_000 });
      await shot(page, 'upscale-image-done', true);
    });

    if (vp.width <= 600) {
      test('upscale-image: slow note on a phone', async ({ page }) => {
        test.slow();
        await device(page, true);
        await installFreeze(page);
        await page.goto('/upscale-image/');
        await routeModels(page, await modelBytes(page));
        await expect(page.locator('[data-scale]')).toHaveAttribute('data-scales', '2');
        // Warm the model (a small photo, no note), then hold the working state of a larger one.
        await aiInput(page).setInputFiles(fixture('rotated-6.jpg'));
        await expect(page.getByRole('button', { name: 'Download PNG' })).toBeEnabled({ timeout: 60_000 });
        await page.getByRole('button', { name: 'Start over' }).click();
        await freezeAt(page, 'work', 0.12);
        await aiInput(page).setInputFiles(PHOTO);
        await frozen(page);
        await expect(page.getByText('This can take a few minutes on this device.', { exact: true })).toBeVisible();
        await shot(page, 'upscale-image-slow-note');
      });
    }

    test.describe('transcribe-audio', () => {
      const open = async (page: Page, cellular = false) => {
        if (cellular) await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { type: 'cellular' } }));
        await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
        await installFreeze(page);
        const models = await routeModels(page, WHISPER_SIZE);
        await page.goto('/transcribe-audio/');
        return models;
      };
      const consent = (page: Page) => page.getByRole('button', { name: 'Download and start' });
      const transcript = (page: Page) => page.getByRole('textbox', { name: 'Transcript' });
      const blurAll = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

      test('empty, consent, downloading, working, done', async ({ page }) => {
        test.slow();
        await open(page);
        await shot(page, 'transcribe-audio-empty', true);
        await aiInput(page).setInputFiles(fixture('audio/hello.wav'));
        await expect(consent(page)).toBeFocused();
        await blurAll(page);
        await shot(page, 'transcribe-audio-consent');
        await freezeAt(page, 'download', 0.27);
        await consent(page).click();
        await frozen(page);
        await expect(aiPanelText(page)).toHaveText(/^Downloading the AI model… \d+ of \d+ MB, one time only$/);
        await blurAll(page);
        await shot(page, 'transcribe-audio-downloading');
        await page.getByRole('button', { name: 'Cancel' }).click();
        await unfreeze(page);
        await consent(page).click();
        await expect(transcript(page)).toHaveValue('This is a test transcript.', { timeout: 60_000 });
        await blurAll(page);
        await shot(page, 'transcribe-audio-done', true);
        await page.getByRole('button', { name: 'Start over' }).click();
        await freezeAt(page, 'work', 0.66, true);
        await aiInput(page).setInputFiles(toneWav('interview.wav', 65));
        await frozen(page);
        await expect(page.locator('[data-ai-live]')).not.toBeEmpty();
        await blurAll(page);
        await shot(page, 'transcribe-audio-working');
      });

      test('consent on mobile data', async ({ page }) => {
        await open(page, true);
        await aiInput(page).setInputFiles(fixture('audio/hello.wav'));
        await expect(page.getByText('You seem to be on mobile data.', { exact: true })).toBeVisible();
        await blurAll(page);
        await shot(page, 'transcribe-audio-consent-cellular');
      });

      test('download failed', async ({ page }) => {
        const models = await open(page);
        models.mode = 'abort';
        await aiInput(page).setInputFiles(fixture('audio/hello.wav'));
        await consent(page).click();
        await expect(page.getByRole('button', { name: 'Try again' })).toBeFocused();
        await blurAll(page);
        await shot(page, 'transcribe-audio-download-failed');
      });

      test('no speech, too large', async ({ page }) => {
        await page.addInitScript(() => {
          const size = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
          Object.defineProperty(Blob.prototype, 'size', {
            get(this: Blob) {
              return this instanceof File && this.name === 'board-meeting.wav' ? 301_000_000 : size.call(this);
            },
          });
        });
        await open(page);
        await aiInput(page).setInputFiles(fixture('audio/silence.wav'));
        await expect(page.getByText("We couldn't hear any speech in this file.", { exact: true })).toBeVisible();
        await shot(page, 'transcribe-audio-no-speech', true);
        await page.getByRole('button', { name: 'Start over' }).click();
        await aiInput(page).setInputFiles({ name: 'board-meeting.wav', mimeType: 'audio/wav', buffer: readFileSync(fixture('audio/hello.wav')) });
        await expect(page.getByText('Files up to 300 MB for now. Try a shorter recording.', { exact: true })).toBeVisible();
        await blurAll(page);
        await shot(page, 'transcribe-audio-too-large', true);
      });
    });

    test('pdf-to-jpg: loaded, converting, done (ZIP), wrong type', async ({ page }) => {
      await installResultHold(page);
      await page.goto('/pdf-to-jpg/');
      await pdf(page, 'three-pages.pdf');
      await expect(page.getByText('3 pages', { exact: true })).toBeVisible();
      await shot(page, 'pdf-to-jpg-loaded');
      await holdResults(page);
      await btn(page, 'Convert').click();
      await waitHeld(page, 3);
      await releaseOne(page);
      await expect(page.getByText('Converting… 33%')).toBeVisible();
      await shot(page, 'pdf-to-jpg-converting');
      await releaseResults(page);
      await expect(page.getByText('3 files', { exact: true })).toBeVisible();
      await shot(page, 'pdf-to-jpg-done-zip');
      await btn(page, 'Start over').click();
      await pdf(page, '../photo.jpg');
      await expect(page.getByText('This is a JPG, not a PDF.')).toBeVisible();
      await shot(page, 'pdf-to-jpg-wrong-type');
    });

    test('jpg-to-pdf: list, done', async ({ page }) => {
      await page.goto('/jpg-to-pdf/');
      await pdf(page, '../photo.jpg', '../alpha.png', '../iphone-12mp.heic');
      await expect(pdfRows(page)).toHaveCount(3);
      await expect(pdfRows(page).nth(2)).toContainText('4032 × 3024 px');
      await shot(page, 'jpg-to-pdf-list');
      await btn(page, 'Create PDF').click();
      await expect(page.getByText(/^3 pages · /)).toBeVisible();
      await shot(page, 'jpg-to-pdf-done');
    });

    test('compress-video: loaded, compressing, done', async ({ page }) => {
      await installFreeze(page);
      await page.goto('/compress-video/');
      await expect(page.locator('[data-kind="video"][data-ready]')).toBeAttached();
      await videoInput(page).setInputFiles(fixture('video/clip.mp4'));
      const compress = page.getByRole('button', { name: 'Compress', exact: true });
      await expect(compress).toBeEnabled();
      await shot(page, 'compress-video-loaded');
      await compress.click();
      await expect(page.getByRole('button', { name: 'Download MP4' })).toBeVisible({ timeout: 60_000 });
      await shot(page, 'compress-video-done');
      await page.getByRole('button', { name: 'Start over' }).click();
      await videoInput(page).setInputFiles(fixture('video/clip.mp4'));
      await expect(compress).toBeEnabled();
      await freezeAt(page, 'work', 0.47);
      await compress.click();
      await frozen(page);
      await expect(page.locator('[data-video-panel] > p').first()).toHaveText(/^Compressing… \d+%$/);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await shot(page, 'compress-video-compressing');
    });

    test('compress-video: unsupported', async ({ page }) => {
      await page.goto('/compress-video/');
      await expect(page.locator('[data-kind="video"][data-ready]')).toBeAttached();
      await videoInput(page).setInputFiles(fixture('video/clip.webm'));
      await expect(page.getByText("This video format isn't supported yet. Try an MP4 or MOV.")).toBeVisible();
      await shot(page, 'compress-video-unsupported');
    });

    test('compress-video: no encoding', async ({ page }) => {
      await page.addInitScript(() => delete (window as { VideoEncoder?: unknown }).VideoEncoder);
      await page.goto('/compress-video/');
      await expect(page.getByText("Your browser can't encode video. Try Chrome, Edge, Safari 17+ or Firefox 130+.")).toBeVisible();
      await shot(page, 'compress-video-no-encode', true);
    });

    test('video-to-gif: loaded, making, done, too long', async ({ page }) => {
      await installFreeze(page);
      await page.goto('/video-to-gif/');
      await expect(page.locator('[data-kind="video"][data-ready]')).toBeAttached();
      await videoInput(page).setInputFiles(fixture('video/clip.mp4'));
      const make = page.getByRole('button', { name: 'Make GIF', exact: true });
      await expect(make).toBeEnabled();
      const preview = page.locator('[data-video-file] video');
      await framePainted(preview);
      await shot(page, 'video-to-gif-loaded', true);
      await page.getByRole('spinbutton', { name: 'End' }).fill('20');
      await make.click();
      await expect(page.locator('[data-trim-error]')).toHaveText('GIFs can be up to 15 seconds.');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await shot(page, 'video-to-gif-too-long');
      await page.getByRole('spinbutton', { name: 'End' }).fill('2');
      await make.click();
      await expect(page.getByRole('button', { name: 'Download GIF' })).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => page.locator('[data-video-done] img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
      await shot(page, 'video-to-gif-done', true);
      await page.getByRole('button', { name: 'Start over' }).click();
      await videoInput(page).setInputFiles(fixture('video/clip.mp4'));
      await expect(make).toBeEnabled();
      await framePainted(preview);
      await freezeAt(page, 'work', 0.55);
      await make.click();
      await frozen(page);
      await expect(page.locator('[data-video-panel] > p').first()).toHaveText(/^Making GIF… \d+%$/);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await shot(page, 'video-to-gif-making');
    });

    test('webp: toggle', async ({ page }) => {
      await page.goto('/webp-to-jpg/');
      await shot(page, 'webp-to-jpg-empty', true);
    });
  });
}
