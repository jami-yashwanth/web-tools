import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { PNG } from 'pngjs';
import { expect, test, type Page } from '@playwright/test';
import { stubPlausible } from './plausible';
import { modelBytes, routeModels } from './models';
import { panelSeen, recordPanel } from './panel';

// Upscale image. In the E2E build (PUBLIC_AI_STUB=1) only the inference is stubbed, as nearest-neighbour ×4 of each
// tile: the model downloads through the real loader (routed bytes), and decoding, orientation, tiling, stitching,
// halving to 2× and the PNG are the real code.

const PHOTO = 'tests/fixtures/photo.jpg'; // 1600×1200: 2× is 7.7 MP, 4× would be 30.7 MP (over the 16 MP cap)
const ROTATED = 'tests/fixtures/rotated-6.jpg'; // stored 400×300, EXIF orientation 6: 300×400 upright
const BIG = 'tests/fixtures/bg-26mp.png'; // 5200×5000: too large even at 2×

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** What the device reports: its memory (navigator.deviceMemory) and whether it is a phone. */
async function device(page: Page, { memory, phone = false }: { memory?: number; phone?: boolean }) {
  await page.addInitScript(
    ([memory, phone, ua]) => {
      const nav = Navigator.prototype;
      if (memory !== null) Object.defineProperty(nav, 'deviceMemory', { get: () => memory, configurable: true });
      if (phone) {
        Object.defineProperty(nav, 'userAgent', { get: () => ua, configurable: true });
        Object.defineProperty(nav, 'userAgentData', { get: () => ({ mobile: true }), configurable: true });
      }
    },
    [memory ?? null, phone, IPHONE] as const,
  );
}

async function open(page: Page, memory = 8) {
  await stubPlausible(page.context());
  await recordPanel(page);
  await device(page, { memory });
  await page.goto('/upscale-image/');
  return routeModels(page, await modelBytes(page));
}

const scale = (page: Page, n: 2 | 4) => page.getByRole('radio', { name: `${n}×` });

async function run(page: Page, file: string) {
  await page.locator('[data-kind="ai"] input[type=file]').setInputFiles(file);
  await expect(page.getByRole('button', { name: 'Download PNG' })).toBeEnabled({ timeout: 60_000 });
}

async function downloadPng(page: Page) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PNG' }).click();
  const download = await downloading;
  return { name: download.suggestedFilename(), png: PNG.sync.read(readFileSync(await download.path())) };
}

/** A PNG whose header says `w` × `h` but which holds no image data: only its header can be read. */
function pngHeaderOnly(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
}

/** Record every note the working panel shows (it can pass quickly). */
async function recordNotes(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { notes: string[] };
    w.notes = [];
    new MutationObserver(() => {
      for (const n of document.querySelectorAll<HTMLElement>('[data-ai-panel] .note'))
        if (!n.hidden && n.textContent && !w.notes.includes(n.textContent)) w.notes.push(n.textContent);
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}
const notes = (page: Page) => page.evaluate(() => (window as unknown as { notes: string[] }).notes);
const SLOW = 'This can take a few minutes on this device.';

const pixel = (png: PNG, x: number, y: number) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];

test('2× (the default): "Upscaling… n%", a before/after slider, and photo-2x.png at double the size', async ({ page }) => {
  const models = await open(page);
  await expect(scale(page, 2)).toBeChecked();
  await run(page, PHOTO);
  expect(models.requests).toBe(1);
  const seen = await panelSeen(page);
  expect(seen.some((t) => /^Downloading the AI model… \d+ of 19 MB, one time only$/.test(t))).toBe(true);
  expect(seen.some((t) => /^Upscaling… \d+%$/.test(t))).toBe(true);
  await expect(page.getByRole('slider', { name: 'Compare before and after' })).toBeVisible();
  // The scale choice belongs with the drop zone: it is not on screen with the result.
  await expect(scale(page, 2)).toBeHidden();

  const { name, png } = await downloadPng(page);
  expect(name).toBe('photo-2x.png');
  expect([png.width, png.height]).toEqual([3200, 2400]);
  expect(pixel(png, 0, 0)[3]).toBe(255);
});

test('4× is offered on a computer with 8 GB, and hidden on a phone or with 4 GB', async ({ page, context }) => {
  await open(page, 8);
  await expect(page.locator('[data-scale]')).toHaveAttribute('data-scales', '2 4');
  await expect(scale(page, 4)).toBeVisible();

  const phone = await context.newPage();
  await device(phone, { memory: 8, phone: true });
  await phone.goto('/upscale-image/');
  // The island decides once it knows the device (data-scales); until then only 2× shows anyway.
  await expect(phone.locator('[data-scale]')).toHaveAttribute('data-scales', '2');
  await expect(phone.getByRole('radio', { name: '2×' })).toBeChecked();
  await expect(phone.locator('[data-scale-4]')).toBeHidden();

  const small = await context.newPage();
  await device(small, { memory: 4 });
  await small.goto('/upscale-image/');
  await expect(small.locator('[data-scale]')).toHaveAttribute('data-scales', '2');
  await expect(small.locator('[data-scale-4]')).toBeHidden();
});

test('too large at 4× says "Try 2×", before any download; 2× then works', async ({ page }) => {
  const models = await open(page);
  await scale(page, 4).check();
  await page.locator('[data-kind="ai"] input[type=file]').setInputFiles(PHOTO);
  await expect(page.getByRole('alert').locator('.error')).toHaveText('Upscaled image would be too large. Try 2×.');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeHidden();
  expect(models.requests).toBe(0);
  await expect(scale(page, 2)).toBeVisible();
  await scale(page, 2).check();
  await run(page, PHOTO);
  expect((await downloadPng(page)).png.width).toBe(3200);
});

test('too large at 2× says the image is too large to upscale', async ({ page }) => {
  const models = await open(page);
  await page.locator('[data-kind="ai"] input[type=file]').setInputFiles(BIG);
  await expect(page.getByRole('alert').locator('.error')).toHaveText('This image is too large to upscale.');
  expect(models.requests).toBe(0);
});

test('an image whose header is too large is rejected from the header alone (never decoded, no download)', async ({ page }) => {
  const models = await open(page);
  // 5000 × 4000 = 20 MP: too large even at 2×. With no pixel data, decoding it would fail as a damaged file.
  await page.locator('[data-kind="ai"] input[type=file]').setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: pngHeaderOnly(5000, 4000) });
  await expect(page.getByRole('alert').locator('.error')).toHaveText('This image is too large to upscale.');
  expect(models.requests).toBe(0);
});

test('where only 2× is offered, an image over 1 MP says it can take a few minutes; not on a computer with 4×', async ({ page, context }) => {
  await open(page, 8);
  await recordNotes(page);
  await run(page, PHOTO); // 1.9 MP
  expect(await notes(page)).not.toContain(SLOW);

  const phone = await context.newPage();
  await device(phone, { memory: 8, phone: true });
  await phone.goto('/upscale-image/');
  await routeModels(phone, await modelBytes(phone));
  await expect(phone.locator('[data-scale]')).toHaveAttribute('data-scales', '2');
  await recordNotes(phone);
  await run(phone, ROTATED); // 0.12 MP: no note
  expect(await notes(phone)).not.toContain(SLOW);
  await phone.getByRole('button', { name: 'Start over' }).click();
  await run(phone, PHOTO);
  expect(await notes(phone)).toContain(SLOW);
});

test('an orientation-6 photo comes out upright at 4×: rotated-6-4x.png, 1200×1600', async ({ page }) => {
  await open(page);
  await scale(page, 4).check();
  await run(page, ROTATED);
  const { name, png } = await downloadPng(page);
  expect(name).toBe('rotated-6-4x.png');
  expect([png.width, png.height]).toEqual([1200, 1600]);
  // Stored top to bottom orange → blue; upright (turned 90° clockwise) that runs right to left.
  const [r1, , b1] = pixel(png, 1190, 800);
  const [r2, , b2] = pixel(png, 10, 800);
  expect(r1).toBeGreaterThan(b1!);
  expect(b2).toBeGreaterThan(r2!);
});

test('Start over revokes the result’s object URLs', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const w = window as unknown as { revoked: string[] };
    w.revoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u: string) => {
      w.revoked.push(u);
      revoke(u);
    };
  });
  await run(page, ROTATED);
  const urls = await page.locator('[data-ai-result] img').evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  expect(urls.length).toBe(2);
  await page.getByRole('button', { name: 'Start over' }).click();
  const revoked = await page.evaluate(() => (window as unknown as { revoked: string[] }).revoked);
  for (const u of urls) expect(revoked).toContain(u);
  await expect(scale(page, 2)).toBeVisible();
});

test('a PDF is a wrong type, with a way to PDF to JPG; nothing downloads', async ({ page }) => {
  const models = await open(page);
  await page.locator('[data-kind="ai"] input[type=file]').setInputFiles('tests/fixtures/pdf/two-pages.pdf');
  const alert = page.getByRole('alert');
  await expect(alert.getByText('This is a PDF, not a JPG, PNG or WebP image.', { exact: true })).toBeVisible();
  await expect(alert.getByRole('link', { name: 'Try PDF to JPG →' })).toHaveAttribute('href', '/pdf-to-jpg/');
  expect(models.requests).toBe(0);
});
