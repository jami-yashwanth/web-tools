import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { holdResults, installResultHold, releaseOne, releaseResults, waitHeld } from './pdf-hold';
import { stubPlausible, type PlausibleEvent } from './plausible';

// Spec §4 PDF to JPG and JPG to PDF states, with the exact copy. Runs against `astro build` + `astro preview`.

let events: PlausibleEvent[];
test.beforeEach(async ({ context, page }) => {
  events = await stubPlausible(context);
  await installResultHold(page);
});

/** The analytics the page has sent, as ['success', count] / ['error', reason]. */
async function expectHooks(expected: [string, unknown][]) {
  const seen = () =>
    events.map((e) => {
      expect(Object.keys(e.p).sort()).toEqual(e.n === 'convert_success' ? ['count', 'tool'] : ['reason', 'tool']);
      return e.n === 'convert_success' ? ['success', e.p.count] : ['error', e.p.reason];
    });
  await expect.poll(seen).toEqual(expected);
  await new Promise((r) => setTimeout(r, 150)); // room for a stray extra event
  expect(seen()).toEqual(expected);
}

const DAMAGED = "We couldn't read this file. It may be damaged or not a PDF.";
const ENCRYPTED = 'This PDF is password-protected. Remove the password and try again.';
const CODEC_FAILED = "Couldn't load the PDF tools. Check your connection.";
// pdf.js's two modules (pdf-<hash>.js, pdf.worker-<hash>.js), and not pdf-lib's chunk or the island's own pdf-images.<hash>.js.
const PDFJS = /\/_astro\/pdf(?!-lib)(\.worker)?-[\w-]+\.js$/;
const PDF_LIB = /\/_astro\/pdf-lib-[\w-]+\.js$/;

const fixture = (name: string) => `tests/fixtures/${name}`;
const choose = (page: Page, ...names: string[]) => page.locator('[data-kind="pdf"] input[type=file]').setInputFiles(names.map(fixture));
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const rows = (page: Page) => page.locator('[data-rows] > li');

async function downloadFrom(page: Page, trigger: Locator) {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger.click()]);
  return { name: download.suggestedFilename(), bytes: new Uint8Array(readFileSync((await download.path())!)) };
}
const magic = (b: Uint8Array, ...bytes: number[]) => bytes.every((v, i) => b[i] === v);
const isJpeg = (b: Uint8Array) => magic(b, 0xff, 0xd8, 0xff);
const isPng = (b: Uint8Array) => magic(b, 0x89, 0x50, 0x4e, 0x47);
const isPdf = (b: Uint8Array) => new TextDecoder().decode(b.subarray(0, 4)) === '%PDF';

/** Decode an image in the page: its size, and how many pixels are dark (the page's text, drawn in black on white). */
async function inspect(page: Page, bytes: Uint8Array, mime: string) {
  return page.evaluate(
    async ({ data, type }) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let dark = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i]! < 100) dark++;
      return { width: bitmap.width, height: bitmap.height, dark };
    },
    { data: [...bytes], type: mime },
  );
}

/** A one-page PDF built in the test, so it never needs a fixture. */
async function onePagePdf(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  return { name: 'solo.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) };
}

test.describe('PDF to JPG', () => {
  test.beforeEach(({ page }) => page.goto('/pdf-to-jpg/'));

  test('empty', async ({ page }) => {
    await expect(page.getByText('Drop a PDF here')).toBeVisible();
    await expect(page.locator('label.btn', { hasText: 'Choose PDF' })).toBeVisible();
    await expect(page.getByText('Converted on your device. Your PDFs are never uploaded.')).toBeVisible();
    await expect(button(page, 'Convert')).toBeHidden();
  });

  test('loaded: name, page count and options', async ({ page }) => {
    await choose(page, 'pdf/three-pages.pdf');
    await expect(page.getByText('three-pages.pdf', { exact: true })).toBeVisible();
    await expect(page.getByText('3 pages', { exact: true })).toBeVisible();
    await expect(page.getByLabel('JPG', { exact: true })).toBeChecked();
    await expect(page.getByLabel('PNG', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel('Standard (150 dpi)')).toBeChecked();
    await expect(page.getByLabel('High (300 dpi)')).not.toBeChecked();
    await expect(button(page, 'Convert')).toBeEnabled();
  });

  test('Convert, standard JPG: a ZIP of three real pages', async ({ page }) => {
    await choose(page, 'pdf/three-pages.pdf');
    await expect(page.getByText('3 pages', { exact: true })).toBeVisible();
    await button(page, 'Convert').click();
    await expect(page.getByText('3 files', { exact: true })).toBeVisible();
    await expect(page.locator('[data-status]')).toHaveText('three-pages-pages.zip ready, 3 files');
    const { name, bytes } = await downloadFrom(page, page.getByRole('link', { name: 'Download all (ZIP)' }));
    expect(name).toBe('three-pages-pages.zip');
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['three-pages-page-1.jpg', 'three-pages-page-2.jpg', 'three-pages-page-3.jpg']);
    for (const f of Object.values(files)) expect(isJpeg(f)).toBe(true);
    // Page n is 200+n pt wide and 300 pt tall: at 150 dpi, that many pixels.
    const p1 = await inspect(page, files['three-pages-page-1.jpg']!, 'image/jpeg');
    expect([p1.width, p1.height]).toEqual([Math.floor((201 * 150) / 72), Math.floor((300 * 150) / 72)]);
    expect(p1.dark).toBeGreaterThan(200); // the "A1" label was drawn: not a blank page
    const p3 = await inspect(page, files['three-pages-page-3.jpg']!, 'image/jpeg');
    expect(p3.width).toBe(Math.floor((203 * 150) / 72));
    await expectHooks([['success', 3]]);
  });

  test('PNG and High (300 dpi)', async ({ page }) => {
    await choose(page, 'pdf/three-pages.pdf');
    await expect(page.getByText('3 pages', { exact: true })).toBeVisible();
    await page.getByLabel('PNG', { exact: true }).check();
    await page.getByLabel('High (300 dpi)').check();
    await button(page, 'Convert').click();
    await expect(page.getByText('3 files', { exact: true })).toBeVisible();
    const { bytes } = await downloadFrom(page, page.getByRole('link', { name: 'Download all (ZIP)' }));
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['three-pages-page-1.png', 'three-pages-page-2.png', 'three-pages-page-3.png']);
    for (const f of Object.values(files)) expect(isPng(f)).toBe(true);
    const p2 = await inspect(page, files['three-pages-page-2.png']!, 'image/png');
    expect([p2.width, p2.height]).toEqual([Math.floor((202 * 300) / 72), Math.floor((300 * 300) / 72)]);
    expect(p2.dark).toBeGreaterThan(200);
  });

  test('a one-page PDF gives a single Download, named for the page', async ({ page }) => {
    await page.locator('[data-kind="pdf"] input[type=file]').setInputFiles(await onePagePdf());
    await expect(page.getByText('1 page', { exact: true })).toBeVisible();
    await button(page, 'Convert').click();
    await expect(page.getByText('solo-page-1.jpg', { exact: true })).toBeVisible();
    await expect(page.getByText(/files$/)).toBeHidden();
    const { name, bytes } = await downloadFrom(page, page.getByRole('link', { name: 'Download', exact: true }));
    expect(name).toBe('solo-page-1.jpg');
    expect(isJpeg(bytes)).toBe(true);
    await expectHooks([['success', 1]]);
    await button(page, 'Start over').click();
    await expect(page.getByText('Drop a PDF here')).toBeVisible();
  });

  test('a page too big for 300 dpi is drawn smaller, and says so', async ({ page }) => {
    const doc = await PDFDocument.create();
    doc.addPage([1500, 1500]); // 300 dpi would be 39 MP
    await page.locator('[data-kind="pdf"] input[type=file]').setInputFiles({ name: 'poster.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
    await expect(page.getByText('1 page', { exact: true })).toBeVisible();
    await page.getByLabel('High (300 dpi)').check();
    await button(page, 'Convert').click();
    await expect(page.getByText("Very large pages were drawn at a lower resolution to fit your device's memory.")).toBeVisible();
    const { bytes } = await downloadFrom(page, page.getByRole('link', { name: 'Download', exact: true }));
    const img = await inspect(page, bytes, 'image/jpeg');
    expect(img.width).toBe(Math.floor((1500 * 150) / 72)); // fell back to 150 dpi
  });

  test('shows progress while pages are made: Converting… n% and a bar', async ({ page }) => {
    await choose(page, 'pdf/three-pages.pdf');
    await expect(page.getByText('3 pages', { exact: true })).toBeVisible();
    await holdResults(page); // pages wait in the page until released, one at a time
    await button(page, 'Convert').click();
    await expect(page.getByText('Converting… 0%')).toBeVisible();
    await expect(page.locator('[data-progress]')).toBeVisible();
    await waitHeld(page, 3); // all three pages are made and waiting
    await releaseOne(page);
    await expect(page.getByText('Converting… 33%')).toBeVisible();
    await expect(page.locator('[data-progress]')).toHaveJSProperty('value', 33);
    await releaseOne(page);
    await expect(page.getByText('Converting… 66%')).toBeVisible();
    await releaseResults(page);
    await expect(page.getByText('3 files', { exact: true })).toBeVisible();
    await expect(page.locator('[data-progress]')).toBeHidden();
  });

  test('an image dropped here is named, with a way to the right tool', async ({ page }) => {
    await choose(page, 'photo.jpg');
    await expect(page.getByText('This is a JPG, not a PDF.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try JPG to PDF →' })).toHaveAttribute('href', '/jpg-to-pdf/');
    await expect(button(page, 'Convert')).toBeHidden();
    await expectHooks([['error', 'wrong-type']]);
  });

  test('a password-protected PDF shows the password copy', async ({ page }) => {
    await choose(page, 'pdf/encrypted.pdf');
    await expect(page.getByText(ENCRYPTED)).toBeVisible();
    await expect(button(page, 'Convert')).toBeHidden();
    await expectHooks([['error', 'encrypted']]);
  });

  test('a file that is not a PDF shows the damaged copy', async ({ page }) => {
    await choose(page, 'pdf/not-a.pdf');
    await expect(page.getByText(DAMAGED)).toBeVisible();
    await expectHooks([['error', 'corrupt']]);
  });

  test('a truncated PDF shows the damaged copy', async ({ page }) => {
    await choose(page, 'pdf/truncated.pdf');
    await expect(page.getByText(DAMAGED)).toBeVisible();
  });

  test('codec load failed, then Try again', async ({ page }) => {
    let blocked = 0;
    await page.context().route(PDFJS, (route) => (blocked++, route.abort()));
    await choose(page, 'pdf/three-pages.pdf');
    await expect(page.getByRole('alert')).toContainText(CODEC_FAILED);
    expect(blocked).toBeGreaterThan(0); // the route really caught pdf.js: the test isn't vacuous
    await expectHooks([['error', 'codec-load']]);
    await page.context().unroute(PDFJS);
    await button(page, 'Try again').click();
    await expect(page.getByText('3 pages', { exact: true })).toBeVisible();
    await expect(page.getByText(CODEC_FAILED)).toBeHidden();
    await button(page, 'Convert').click();
    await expect(page.getByText('3 files', { exact: true })).toBeVisible();
    await expectHooks([['error', 'codec-load'], ['success', 3]]);
  });
});

test.describe('JPG to PDF', () => {
  test.beforeEach(({ page }) => page.goto('/jpg-to-pdf/'));
  const widths = async (b: Uint8Array) => (await PDFDocument.load(b)).getPages().map((p) => [Math.round(p.getSize().width * 100) / 100, Math.round(p.getSize().height * 100) / 100]);

  test('empty', async ({ page }) => {
    await expect(page.getByText('Drop images here')).toBeVisible();
    await expect(page.locator('label.btn', { hasText: 'Choose images' })).toBeVisible();
    await expect(page.getByText('Converted on your device. Your images are never uploaded.')).toBeVisible();
    await expect(button(page, 'Create PDF')).toBeHidden();
  });

  test('a single image makes a one-page PDF', async ({ page }) => {
    await choose(page, 'photo.jpg');
    await expect(rows(page).first()).toContainText('1600 × 1200 px');
    await expect(button(page, 'Create PDF')).toBeEnabled();
    await button(page, 'Create PDF').click();
    await expect(page.getByText(/^1 page · \d+ KB$/)).toBeVisible();
    const { name, bytes } = await downloadFrom(page, page.getByRole('link', { name: 'Download', exact: true }));
    expect(name).toBe('images.pdf');
    expect(isPdf(bytes)).toBe(true);
    expect(await widths(bytes)).toEqual([[1200, 900]]);
    await expectHooks([['success', 1]]);
  });

  test('JPG, PNG and HEIC: rows, reorder, Create PDF keeps the shown order', async ({ page }) => {
    await choose(page, 'photo.jpg', 'alpha.png', 'iphone-12mp.heic');
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).nth(2)).toContainText('4032 × 3024 px'); // the HEIC was decoded
    await expect(rows(page).nth(1)).toContainText('200 × 150 px');
    await expect(rows(page).first().getByRole('button', { name: 'Move up' })).toBeDisabled();
    await rows(page).nth(2).getByRole('button', { name: 'Move up' }).click(); // photo, heic, png
    await rows(page).nth(1).getByRole('button', { name: 'Move up' }).click(); // heic, photo, png
    await expect(rows(page).first()).toContainText('iphone-12mp.heic');
    await button(page, 'Create PDF').click();
    await expect(page.getByText(/^3 pages · \d+(\.\d)? (KB|MB)$/)).toBeVisible();
    await expect(page.locator('[data-status]')).toHaveText(/^images\.pdf ready, 3 pages · /);
    const { name, bytes } = await downloadFrom(page, page.getByRole('link', { name: 'Download', exact: true }));
    expect(name).toBe('images.pdf');
    expect(await widths(bytes)).toEqual([[3024, 2268], [1200, 900], [150, 112.5]]);
    await expectHooks([['success', 1]]);
  });

  test('A4 and Letter give pages of that size', async ({ page }) => {
    await choose(page, 'photo.jpg', 'alpha.png');
    await expect(rows(page).last()).toContainText('200 × 150 px');
    await page.getByLabel('A4').check();
    await button(page, 'Create PDF').click();
    await expect(page.getByText(/^2 pages · /)).toBeVisible();
    const { bytes } = await downloadFrom(page, page.getByRole('link', { name: 'Download', exact: true }));
    expect(await widths(bytes)).toEqual([[595.28, 841.89], [595.28, 841.89]]);
  });

  test('a WebP is accepted and becomes a PNG page', async ({ page }) => {
    await choose(page, 'lossy.webp');
    await expect(rows(page).first()).toContainText('800 × 600 px');
    await button(page, 'Create PDF').click();
    const { bytes } = await downloadFrom(page, page.getByRole('link', { name: 'Download', exact: true }));
    expect(await widths(bytes)).toEqual([[600, 450]]);
  });

  test('a JPEG saved sideways (EXIF rotation) comes out upright', async ({ page }) => {
    await choose(page, 'rotated-6.jpg');
    await expect(rows(page).first()).toContainText('300 × 400 px');
    await button(page, 'Create PDF').click();
    const { bytes } = await downloadFrom(page, page.getByRole('link', { name: 'Download', exact: true }));
    expect(await widths(bytes)).toEqual([[225, 300]]);
  });

  test('a file that is not an image blocks Create PDF until removed', async ({ page }) => {
    await choose(page, 'photo.jpg', 'pdf/not-a.pdf');
    await expect(rows(page).last()).toContainText("We couldn't read this file. It may be damaged or incomplete.");
    await expect(button(page, 'Create PDF')).toBeDisabled();
    await expectHooks([['error', 'corrupt']]);
    await rows(page).last().getByRole('button', { name: 'Remove' }).click();
    await expect(button(page, 'Create PDF')).toBeEnabled();
  });

  test('a damaged image shows the damaged copy', async ({ page }) => {
    await choose(page, 'truncated.heic');
    await expect(rows(page).first()).toContainText("We couldn't read this file. It may be damaged or incomplete.");
    await expect(button(page, 'Create PDF')).toBeDisabled();
  });

  test('codec load failed, then Try again', async ({ page }) => {
    let blocked = 0;
    await page.context().route(PDF_LIB, (route) => (blocked++, route.abort()));
    await choose(page, 'photo.jpg');
    await expect(rows(page).first()).toContainText('1600 × 1200 px');
    await button(page, 'Create PDF').click();
    await expect(page.getByRole('alert')).toContainText(CODEC_FAILED);
    expect(blocked).toBeGreaterThan(0);
    await expect(rows(page).first()).toBeVisible(); // the list is back, nothing lost
    await expectHooks([['error', 'codec-load']]);
    await page.context().unroute(PDF_LIB);
    await button(page, 'Try again').click();
    await expect(page.getByText(/^1 page · /)).toBeVisible();
    await expectHooks([['error', 'codec-load'], ['success', 1]]);
  });
});
