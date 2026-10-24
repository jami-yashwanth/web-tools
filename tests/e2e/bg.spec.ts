import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { expect, test, type Page } from '@playwright/test';
import { stubPlausible } from './plausible';
import { modelBytes, routeModels } from './models';
import { panelSeen, recordPanel } from './panel';

// Remove background. In the E2E build (PUBLIC_AI_STUB=1) only the inference is stubbed: the model downloads
// through the real loader (routed bytes), the photo is really decoded and turned upright, and the mask (a centre
// ellipse) is really upsampled, composed and encoded as a PNG.

const PHOTO = 'tests/fixtures/photo.jpg'; // 1600×1200
const BIG = 'tests/fixtures/bg-26mp.png'; // 5200×5000, 26 MP

async function open(page: Page) {
  await stubPlausible(page.context());
  await recordPanel(page);
  await page.goto('/remove-background/');
  return routeModels(page, await modelBytes(page));
}

async function run(page: Page, file = PHOTO) {
  await page.locator('[data-kind="ai"] input[type=file]').setInputFiles(file);
  await expect(page.getByRole('button', { name: 'Download PNG' })).toBeEnabled({ timeout: 60_000 });
}

async function downloadPng(page: Page) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PNG' }).click();
  const download = await downloading;
  const bytes = readFileSync(await download.path());
  return { name: download.suggestedFilename(), bytes, png: PNG.sync.read(bytes) };
}

const pixel = (png: PNG, x: number, y: number) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];

test('download (no consent: 5 MB) → "Removing background… n%" → a checkerboard result with a keyboard before/after slider', async ({ page }) => {
  const models = await open(page);
  await run(page);
  expect(models.requests).toBe(1);
  const seen = await panelSeen(page);
  expect(seen.some((t) => /^Downloading the AI model… \d+ of \d+ MB, one time only$/.test(t))).toBe(true);
  expect(seen.some((t) => /^Removing background… \d+%$/.test(t))).toBe(true);

  const result = page.locator('[data-ai-result]');
  await expect(result.locator('[data-checkerboard]')).toBeVisible();
  const slider = page.getByRole('slider', { name: 'Compare before and after' });
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute('aria-valuenow', '50');
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuenow', '45');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '55');
  await expect(page.getByRole('radio', { name: 'Transparent' })).toBeChecked();
  await expect(page.getByText('Large photo: processed at 25 MP.')).toBeHidden();
});

test('Download PNG gives photo-no-bg.png: a PNG with an alpha channel, transparent corners and an opaque subject', async ({ page }) => {
  await open(page);
  await run(page);
  const { name, bytes, png } = await downloadPng(page);
  expect(name).toBe('photo-no-bg.png');
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
  expect(bytes[25]).toBe(6); // colour type 6: RGBA
  expect([png.width, png.height]).toEqual([1600, 1200]);
  for (const [x, y] of [[0, 0], [1599, 0], [0, 1199], [1599, 1199]] as const) expect(pixel(png, x, y)[3]).toBe(0);
  expect(pixel(png, 800, 600)[3]).toBe(255);
});

test('White gives opaque white corners, re-composed without running the model again', async ({ page }) => {
  const models = await open(page);
  await run(page);
  const seenBefore = (await panelSeen(page)).length;
  await page.getByRole('radio', { name: 'White' }).check();
  await expect(page.getByRole('button', { name: 'Download PNG' })).toBeEnabled();
  const { name, png } = await downloadPng(page);
  expect(name).toBe('photo-no-bg.png');
  for (const [x, y] of [[0, 0], [1599, 1199]] as const) expect(pixel(png, x, y)).toEqual([255, 255, 255, 255]);
  // No new download, and the working state never came back.
  expect(models.requests).toBe(1);
  expect((await panelSeen(page)).length).toBe(seenBefore);

  // Colour: a colour input appears; its colour fills the corners.
  await page.getByRole('radio', { name: 'Colour' }).check();
  const colour = page.getByLabel('Background colour');
  await expect(colour).toBeVisible();
  await colour.fill('#ff0000');
  await expect(page.getByRole('button', { name: 'Download PNG' })).toBeEnabled();
  const red = await downloadPng(page);
  expect(pixel(red.png, 0, 0)).toEqual([255, 0, 0, 255]);
});

test('a photo over 25 MP is processed at 25 MP, with a note', async ({ page }) => {
  await open(page);
  await run(page, BIG);
  await expect(page.getByText('Large photo: processed at 25 MP.', { exact: true })).toBeVisible();
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
  await run(page);
  const urls = await page.locator('[data-ai-result] img').evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  expect(urls.length).toBe(2);
  await page.getByRole('button', { name: 'Start over' }).click();
  const revoked = await page.evaluate(() => (window as unknown as { revoked: string[] }).revoked);
  for (const u of urls) expect(revoked).toContain(u);
});

test('a PDF is a wrong type, with a way to PDF to JPG; nothing downloads', async ({ page }) => {
  const models = await open(page);
  await page.locator('[data-kind="ai"] input[type=file]').setInputFiles('tests/fixtures/pdf/two-pages.pdf');
  const alert = page.getByRole('alert');
  await expect(alert.getByText('This is a PDF, not a JPG, PNG or WebP image.', { exact: true })).toBeVisible();
  await expect(alert.getByRole('link', { name: 'Try PDF to JPG →' })).toHaveAttribute('href', '/pdf-to-jpg/');
  expect(models.requests).toBe(0);
});
