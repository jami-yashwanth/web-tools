import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { stubPlausible } from './plausible';
import { panelSeen, recordPanel } from './panel';
import { holdResults, installResultHold } from './pdf-hold';

// Video to GIF, end to end with the browser's own WebCodecs: mp4box.js reads the MP4, VideoDecoder decodes the trimmed
// span, frames are sampled and scaled on an OffscreenCanvas, and gifenc writes the GIF that is downloaded. Nothing is
// stubbed.

const V = 'tests/fixtures/video';
const CLIP = `${V}/clip.mp4`; // 3 s, H.264 High + AAC, 640 × 360, 30 fps
const ROTATED = `${V}/rotated.mp4`; // stored 640 × 360, turned a quarter clockwise: plays as 360 × 640, 1 s
const LONG = `${V}/long-130s.mp4`; // 2 min 10 s, 160 × 90 at 10 fps: over Compress's limit, not GIF's
const WEBM = `${V}/clip.webm`;

const SPAN = 'GIFs can be up to 15 seconds.';
const RANGE = 'End must be after start and within the video.';
const NO_DECODE = "Your browser can't read video. Try Chrome, Edge, Safari 17+ or Firefox 130+.";
const LARGE = 'Large GIF. Try 320 px or a shorter clip for a smaller file.';
const UNSUPPORTED = "This video format isn't supported yet. Try an MP4 or MOV.";

interface GifInfo {
  width: number;
  height: number;
  frames: number;
  /** Each frame's delay, in hundredths of a second. */
  delays: number[];
  loops: boolean;
}

/** Walk a GIF's blocks: its logical screen, its frames and their delays, and whether it loops. */
function gifInfo(b: Buffer): GifInfo {
  expect(b.subarray(0, 6).toString('latin1')).toBe('GIF89a');
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  let p = 13;
  if (b[10]! & 0x80) p += 3 * 2 ** ((b[10]! & 7) + 1); // the global colour table
  const skipSubBlocks = () => {
    while (b[p]) p += b[p]! + 1;
    p++;
  };
  const delays: number[] = [];
  let frames = 0;
  let loops = false;
  for (;;) {
    const id = b[p++];
    if (id === 0x3b) break; // trailer
    if (id === 0x21) {
      const label = b[p++];
      if (label === 0xf9) delays.push(b.readUInt16LE(p + 2));
      if (label === 0xff && b.subarray(p + 1, p + 12).toString('latin1') === 'NETSCAPE2.0') loops = b.readUInt16LE(p + 14) === 0;
      skipSubBlocks();
    } else if (id === 0x2c) {
      frames++;
      const packed = b[p + 8]!;
      p += 9;
      if (packed & 0x80) p += 3 * 2 ** ((packed & 7) + 1); // a local colour table
      p++; // LZW minimum code size
      skipSubBlocks();
    } else throw new Error(`unexpected GIF block 0x${id?.toString(16)} at ${p - 1}`);
  }
  return { width, height, frames, delays, loops };
}

async function open(page: Page, path = '/video-to-gif/') {
  await stubPlausible(page.context());
  await recordPanel(page);
  await page.goto(path);
  await expect(page.locator('[data-kind="video"][data-ready]')).toBeAttached(); // the island has mounted
}

const fileInput = (page: Page) => page.locator('[data-kind="video"] input[type=file]');
const makeBtn = (page: Page) => page.getByRole('button', { name: 'Make GIF', exact: true });
const startInput = (page: Page) => page.getByRole('spinbutton', { name: 'Start' });
const endInput = (page: Page) => page.getByRole('spinbutton', { name: 'End' });
const trimError = (page: Page) => page.locator('[data-trim-error]');
const alertText = (page: Page) => page.locator('[data-video-alert] .error');

/** Choose a file and wait until it has been read (Make GIF is ready). */
async function choose(page: Page, file: string) {
  await fileInput(page).setInputFiles(file);
  await expect(makeBtn(page)).toBeEnabled();
}

async function trim(page: Page, start: string, end: string) {
  await startInput(page).fill(start);
  await endInput(page).fill(end);
}

async function make(page: Page) {
  await makeBtn(page).click();
  await expect(page.getByRole('button', { name: 'Download GIF' })).toBeVisible({ timeout: 60_000 });
}

async function download(page: Page) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download GIF' }).click();
  const d = await downloading;
  return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()) };
}

test('empty state: drop line, button, privacy line; MP4 and MOV only', async ({ page }) => {
  await open(page);
  await expect(page.getByText('Drop a video here')).toBeVisible();
  await expect(page.getByText('Converted on your device. Your videos are never uploaded.')).toBeVisible();
  const accept = await fileInput(page).getAttribute('accept');
  expect(accept).toContain('video/mp4');
  expect(accept).not.toContain('webm');
});

test('a video: the trim preview, Start 0 and End at most 5 s, 320 px and 10 fps', async ({ page }) => {
  await open(page);
  await choose(page, CLIP);
  await expect(page.locator('[data-video-file]')).toContainText('clip.mp4');
  await expect(page.locator('[data-video-file]')).toContainText('640 × 360 · 0:03');
  const preview = page.locator('[data-video-file] video');
  await expect(preview).toBeVisible();
  expect(await preview.getAttribute('src')).toMatch(/^blob:/);
  expect(await preview.evaluate((v: HTMLVideoElement) => v.muted && v.controls)).toBe(true);
  await expect(startInput(page)).toHaveValue('0');
  await expect(endInput(page)).toHaveValue('3');
  await expect(page.getByRole('radio', { name: '320 px' })).toBeChecked();
  await expect(page.getByRole('radio', { name: '10 fps' })).toBeChecked();
});

test('clip.mp4, 0–2 s at 320 px and 10 fps: Making GIF… n%, then clip.gif, 320 wide, 20 frames, looping', async ({ page }) => {
  await open(page);
  await choose(page, CLIP);
  await trim(page, '0', '2');
  await make(page);

  expect((await panelSeen(page)).some((t) => /^Making GIF… \d+%$/.test(t))).toBe(true);
  const preview = page.locator('[data-video-done] img');
  await expect(preview).toBeVisible();
  expect(await preview.getAttribute('src')).toMatch(/^blob:/);
  expect(await preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);

  const { name, bytes } = await download(page);
  expect(name).toBe('clip.gif');
  const gif = gifInfo(bytes);
  expect(gif).toMatchObject({ width: 320, height: 180, frames: 20, loops: true });
  expect(gif.delays.every((d) => d === 10)).toBe(true);
  await expect(page.locator('[data-video-sizes]')).toHaveText(`320 × 180 · ${Math.max(1, Math.round(bytes.length / 1000))} KB`);
  await expect(page.locator('[data-gif-note]')).toBeHidden();
});

test('a GIF over 20 MB: the result says how to get a smaller one', async ({ page }) => {
  // Stand-in for a long 480 px clip: the worker's GIF is swapped for 20 MB and a byte as it reaches the page.
  await page.addInitScript(() => {
    const Base = window.Worker;
    window.Worker = class extends Base {
      set onmessage(fn: ((e: MessageEvent) => void) | null) {
        super.onmessage = (e: MessageEvent) => {
          const big = e.data?.kind === 'done' && e.data.result instanceof Blob;
          const data = big ? { ...e.data, result: new Blob([new Uint8Array(20_000_001)], { type: 'image/gif' }) } : e.data;
          fn?.call(this, big ? new MessageEvent('message', { data }) : e);
        };
      }
      get onmessage() {
        return super.onmessage;
      }
    };
  });
  await open(page);
  await choose(page, CLIP);
  await trim(page, '0', '0.5');
  await make(page);
  await expect(page.locator('[data-video-sizes]')).toHaveText('320 × 180 · 20.0 MB');
  await expect(page.locator('[data-gif-note]')).toHaveText(LARGE);
});

test('480 px at 15 fps, from 1 s to 2 s', async ({ page }) => {
  await open(page);
  await choose(page, CLIP);
  await trim(page, '1', '2');
  await page.getByRole('radio', { name: '480 px' }).check();
  await page.getByRole('radio', { name: '15 fps' }).check();
  await make(page);
  const gif = gifInfo((await download(page)).bytes);
  expect(gif).toMatchObject({ width: 480, height: 270, frames: 15 });
});

test('a portrait phone video: the GIF comes out upright', async ({ page }) => {
  await open(page);
  await choose(page, ROTATED);
  await expect(page.locator('[data-video-file]')).toContainText('360 × 640 · 0:01');
  await make(page);
  const gif = gifInfo((await download(page)).bytes);
  expect(gif.width).toBe(320);
  expect(gif.height).toBe(568);
});

test('a span of 0–20 s: GIFs can be up to 15 seconds', async ({ page }) => {
  await open(page);
  await choose(page, CLIP);
  await trim(page, '0', '20');
  await makeBtn(page).click();
  await expect(trimError(page)).toHaveText(SPAN);
  await expect(page.locator('[data-video-panel]')).toBeHidden();
  // Corrected, it goes.
  await trim(page, '0', '1');
  await make(page);
  await expect(trimError(page)).toBeHidden();
});

test('an end before the start, or past the end of the video: End must be after start', async ({ page }) => {
  await open(page);
  await choose(page, CLIP);
  await trim(page, '2', '1');
  await makeBtn(page).click();
  await expect(trimError(page)).toHaveText(RANGE);
  await trim(page, '0', '4');
  await makeBtn(page).click();
  await expect(trimError(page)).toHaveText(RANGE);
  await trim(page, '', '2');
  await makeBtn(page).click();
  await expect(trimError(page)).toHaveText(RANGE);
  await expect(page.locator('[data-video-panel]')).toBeHidden();
});

test('no VideoDecoder: the browser cannot read video', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { VideoDecoder?: unknown }).VideoDecoder;
  });
  await open(page);
  await expect(page.getByText(NO_DECODE)).toBeVisible();
  await expect(page.locator('.drop')).toBeHidden();
});

test('no VideoEncoder: a GIF needs no encoder, so it still works', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { VideoEncoder?: unknown }).VideoEncoder;
  });
  await open(page);
  await expect(page.locator('[data-video-alert]')).toBeHidden();
  await choose(page, CLIP);
  await trim(page, '0', '0.5');
  await make(page);
  expect(gifInfo((await download(page)).bytes).frames).toBe(5);
});

test('a video over 2 minutes: no length cap for GIFs, 0–2 s makes a 20-frame GIF', async ({ page }) => {
  await open(page);
  await choose(page, LONG);
  await expect(page.locator('[data-video-alert]')).toBeHidden();
  await expect(page.locator('[data-video-file]')).toContainText('160 × 90 · 2:10');
  await trim(page, '0', '2');
  await make(page);
  const { name, bytes } = await download(page);
  expect(name).toBe('long-130s.gif');
  expect(gifInfo(bytes)).toMatchObject({ width: 320, height: 180, frames: 20 });
});

test('larger than 200 MB: the size limit (GIFs have no length limit), before the file is read', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('[data-kind="video"] input[type=file]')!;
    const file = new File([new Uint8Array(16)], 'big.mp4', { type: 'video/mp4' });
    Object.defineProperty(file, 'size', { value: 200_000_001 }); // the metadata says so; no 200 MB in the test
    Object.defineProperty(input, 'files', { value: { 0: file, length: 1, item: () => file }, configurable: true });
    input.dispatchEvent(new Event('change'));
  });
  await expect(alertText(page)).toHaveText('Videos up to 200 MB for now.');
});

test('WebM: not supported yet', async ({ page }) => {
  await open(page);
  await fileInput(page).setInputFiles(WEBM);
  await expect(alertText(page)).toHaveText(UNSUPPORTED);
});

test('a photo: wrong type, with a way to the image tool', async ({ page }) => {
  await open(page);
  await fileInput(page).setInputFiles('tests/fixtures/photo.jpg');
  await expect(alertText(page)).toHaveText('This is a JPG, not a video.');
  await expect(page.getByRole('link', { name: 'Try Compress image →' })).toHaveAttribute('href', '/compress-image/');
});

test('Cancel goes back to the trim; Start over goes back to the start and lets go of the video', async ({ page }) => {
  await installResultHold(page);
  await open(page);
  await choose(page, CLIP);
  await holdResults(page); // the result waits, so Cancel is there to press however fast the work is
  await makeBtn(page).click();
  await expect(page.getByText(/^Making GIF… \d+%$/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(makeBtn(page)).toBeVisible();
  await expect(page.locator('[data-video-panel]')).toBeHidden();
  await page.evaluate(() => ((window as unknown as { __hold: boolean }).__hold = false));
  await trim(page, '0', '0.5');
  await make(page);
  await page.getByRole('button', { name: 'Start over' }).click();
  await expect(page.getByText('Drop a video here')).toBeVisible();
  await expect(makeBtn(page)).toBeHidden();
  expect(await page.locator('[data-kind="video"] video').getAttribute('src')).toBeNull();
  expect(await page.locator('[data-video-done] img').getAttribute('src')).toBeNull();
});

/** The JavaScript a page loads before any file is chosen. */
async function scriptsOnLoad(page: Page, path: string): Promise<string> {
  const bodies: Promise<string>[] = [];
  page.on('response', (res) => {
    if (res.request().resourceType() === 'script' && new URL(res.url()).pathname.startsWith('/_astro/')) bodies.push(res.text());
  });
  await open(page, path);
  await page.waitForLoadState('networkidle');
  return (await Promise.all(bodies)).join('\n');
}

test('each video page loads only its own island', async ({ page }) => {
  const gifJs = await scriptsOnLoad(page, '/video-to-gif/');
  expect(gifJs).toContain('Making GIF');
  expect(gifJs).not.toContain('Compressing');
  const compressJs = await scriptsOnLoad(page, '/compress-video/');
  expect(compressJs).toContain('Compressing');
  expect(compressJs).not.toContain('Making GIF');
});
