import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { stubPlausible } from './plausible';
import { panelSeen, recordPanel } from './panel';

// Image to text, with the real tesseract.js and the real tessdata_fast `eng` model (the committed fixture, served
// from the routed model host). Only the host is routed: the OCR itself is not stubbed.

const MODEL = readFileSync('tests/fixtures/models/tessdata/eng.traineddata.gz');
const HELLO = 'tests/fixtures/ocr/hello.png';

async function open(page: Page) {
  await stubPlausible(page.context());
  await recordPanel(page);
  // The language data ships with the site (same origin), so no model host is routed. Count its requests.
  const models = { requests: 0, body: undefined as Buffer | undefined };
  await page.route('**/models/tessdata/eng-fast-4.1.0.traineddata.gz.bin', (route) => {
    models.requests++;
    return models.body ? route.fulfill({ status: 200, contentType: 'application/octet-stream', body: models.body }) : route.continue();
  });
  await page.goto('/image-to-text/');
  return models;
}
const choose = (page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) =>
  page.locator('[data-kind="ai"] input[type=file]').setInputFiles(file);
const box = (page: Page) => page.getByRole('textbox', { name: 'Text' });

test('reads the text, shows download then reading progress, and Copy and Download .txt work', async ({ page, context, browserName }) => {
  const models = await open(page);
  await choose(page, HELLO);

  await expect(box(page)).toHaveValue(/quick brown fox/i);
  await expect(box(page)).toHaveValue(/12345/);
  const seen = await panelSeen(page);
  expect(seen.some((t) => /^Downloading the AI model… /.test(t))).toBe(true); // first use, no consent screen
  expect(seen.some((t) => /^Reading text… \d+%$/.test(t))).toBe(true);
  expect(models.requests).toBe(1);
  await expect(page.getByText('Language: English')).toBeVisible();
  await expect(page.locator('[data-low-confidence]')).toHaveCount(0);

  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/quick brown fox/i);

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .txt' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('hello.txt');
  const path = await download.path();
  expect(readFileSync(path, 'utf8')).toMatch(/quick brown fox/i);
});

test('a second image reads from the cached model: no second download', async ({ page }) => {
  const models = await open(page);
  await choose(page, HELLO);
  await expect(box(page)).toHaveValue(/quick brown fox/i);
  await page.getByRole('button', { name: 'Start over' }).click();
  await choose(page, HELLO);
  await expect(box(page)).toHaveValue(/quick brown fox/i);
  expect(models.requests).toBe(1);
});

test('an image with no text says so', async ({ page }) => {
  await open(page);
  await choose(page, 'tests/fixtures/ocr/blank.png');
  await expect(page.getByText("We couldn't find any text in this image.", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy' })).toHaveCount(0);
});

test('a noisy, blurred image shows the low-confidence note beside the text', async ({ page }) => {
  await open(page);
  await choose(page, 'tests/fixtures/ocr/low-confidence.png');
  await expect(page.getByText('Some text may be wrong. Check it before using.', { exact: true })).toBeVisible();
  await expect(box(page)).toBeVisible();
});

test('a PDF is a wrong type, with a way to PDF to JPG', async ({ page }) => {
  await open(page);
  await choose(page, 'tests/fixtures/pdf/two-pages.pdf');
  const alert = page.getByRole('alert');
  await expect(alert.getByText('This is a PDF, not a JPG, PNG or WebP image.', { exact: true })).toBeVisible();
  await expect(alert.getByRole('link', { name: 'Try PDF to JPG →' })).toHaveAttribute('href', '/pdf-to-jpg/');
});

test('a damaged language file is a failed download that Try again fixes', async ({ page }) => {
  const models = await open(page);
  models.body = Buffer.from('<html>Not found</html>');
  await choose(page, HELLO);
  await expect(page.getByRole('alert').getByText("Couldn't download the AI model. Check your connection.", { exact: true })).toBeVisible();
  models.body = undefined; // the real file from the site again
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(box(page)).toHaveValue(/quick brown fox/i);
});
