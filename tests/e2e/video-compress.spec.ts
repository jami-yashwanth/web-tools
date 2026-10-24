import { readFileSync } from 'node:fs';
import { createFile, Log, type Movie } from 'mp4box';
import { expect, test, type Page } from '@playwright/test';
import { stubPlausible } from './plausible';
import { panelSeen, recordPanel } from './panel';
import { holdResults, installResultHold } from './pdf-hold';
import { rotationOf } from '../../src/video/demux';

// Compress video, end to end with the browser's own WebCodecs: mp4box.js reads the MP4, VideoDecoder decodes it,
// VideoEncoder makes H.264 of it and mp4-muxer writes the MP4 that is downloaded. Nothing is stubbed.

const V = 'tests/fixtures/video';
const CLIP = `${V}/clip.mp4`; // 3 s, H.264 High + AAC, 640 × 360, 30 fps, about 0.9 MB
const HD = `${V}/hd.mp4`; // 1 s, 1920 × 1080, no sound
const OPUS = `${V}/opus-sound.mp4`; // H.264 + Opus sound
const TINY = `${V}/well-compressed.mp4`; // grain at 80 kbit/s
const LONG = `${V}/too-long.mp4`; // 2 min 1 s
const WEBM = `${V}/clip.webm`;
const TRUNCATED = `${V}/truncated.mp4`;
const ROTATED = `${V}/rotated.mp4`; // stored 640 × 360, turned a quarter clockwise: plays as 360 × 640

const NO_ENCODE = "Your browser can't encode video. Try Chrome, Edge, Safari 17+ or Firefox 130+.";
const LIMITS = 'Videos up to 2 minutes and 200 MB for now.';
const UNSUPPORTED = "This video format isn't supported yet. Try an MP4 or MOV.";
const UNDECODABLE = "This browser can't play this video's format. Try Chrome, Edge or Safari.";
const DAMAGED = "We couldn't read this file. It may be damaged or incomplete.";

Log.setLogLevel(Log.error);

/** What mp4box.js makes of an MP4 file. */
function mp4Info(bytes: Buffer): Movie {
  const f = createFile();
  let info: Movie | undefined;
  f.onReady = (i) => (info = i);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer & { fileStart: number };
  ab.fileStart = 0;
  f.appendBuffer(ab, true);
  f.flush();
  if (!info) throw new Error('not an MP4 mp4box can read');
  return info;
}

async function open(page: Page) {
  await stubPlausible(page.context());
  await recordPanel(page);
  await page.goto('/compress-video/');
  await expect(page.locator('[data-kind="video"][data-ready]')).toBeAttached(); // the island has mounted
}

const fileInput = (page: Page) => page.locator('[data-kind="video"] input[type=file]');
const compressBtn = (page: Page) => page.getByRole('button', { name: 'Compress', exact: true });
const alertText = (page: Page) => page.locator('[data-video-alert] .error');

/** Choose a file and wait until it has been read (Compress is ready). */
async function choose(page: Page, file: string) {
  await fileInput(page).setInputFiles(file);
  await expect(compressBtn(page)).toBeEnabled();
}

async function compress(page: Page) {
  await compressBtn(page).click();
  await expect(page.getByRole('button', { name: 'Download MP4' })).toBeVisible({ timeout: 60_000 });
}

async function download(page: Page) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download MP4' }).click();
  const d = await downloading;
  return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()) };
}

test('empty state: drop line, button, privacy line; MP4 and MOV only', async ({ page }) => {
  await open(page);
  await expect(page.getByText('Drop a video here')).toBeVisible();
  await expect(page.getByText('Converted on your device. Your videos are never uploaded.')).toBeVisible();
  const accept = await fileInput(page).getAttribute('accept');
  expect(accept).toContain('video/mp4');
  expect(accept).toContain('video/quicktime');
  expect(accept).not.toContain('webm');
});

test('clip.mp4: Compressing… n%, then "<in> → <out>" and an MP4 of the same length, with its AAC sound', async ({ page }) => {
  await open(page);
  await choose(page, CLIP);
  await expect(page.locator('[data-video-file]')).toContainText('clip.mp4');
  await expect(page.locator('[data-video-file]')).toContainText('640 × 360 · 0:03');
  // The defaults: Balanced, Original.
  await expect(page.getByRole('radio', { name: 'Balanced' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Original' })).toBeChecked();
  await page.getByRole('radio', { name: '720p' }).check();
  await compress(page);

  expect((await panelSeen(page)).some((t) => /^Compressing… \d+%$/.test(t))).toBe(true);
  const inSize = readFileSync(CLIP).length;
  const { name, bytes } = await download(page);
  expect(name).toBe('clip-compressed.mp4');
  expect(bytes.subarray(0, 12).toString('latin1')).toContain('ftyp');
  const sizes = `${Math.round(inSize / 1000)} KB → ${Math.max(1, Math.round(bytes.length / 1000))} KB`;
  await expect(page.locator('[data-video-sizes]')).toHaveText(sizes);
  expect(bytes.length).toBeLessThan(inSize);

  const info = mp4Info(bytes);
  expect(Math.abs(info.duration / info.timescale - 3)).toBeLessThanOrEqual(0.2);
  const video = info.videoTracks[0]!;
  expect(video.codec).toMatch(/^avc1\./);
  expect(video.video!.width).toBeLessThanOrEqual(720);
  expect(video.video).toEqual({ width: 640, height: 360 }); // never made larger
  expect(video.nb_samples).toBe(90);
  expect(info.audioTracks[0]?.codec).toMatch(/^mp4a\.40/); // the sound, copied as it was
  await expect(page.locator('[data-video-notes]')).toBeHidden();
});

test('720p on a 1080p video: 1280 × 720', async ({ page }) => {
  await open(page);
  await choose(page, HD);
  await page.getByRole('radio', { name: '720p' }).check();
  await compress(page);
  const info = mp4Info((await download(page)).bytes);
  expect(info.videoTracks[0]!.video).toEqual({ width: 1280, height: 720 });
  expect(info.audioTracks).toHaveLength(0);
});

test('sound that is not AAC is left out, with a note', async ({ page }) => {
  await open(page);
  await choose(page, OPUS);
  await compress(page);
  await expect(page.locator('[data-video-notes]')).toHaveText("This video's sound couldn't be kept.");
  const info = mp4Info((await download(page)).bytes);
  expect(info.videoTracks).toHaveLength(1);
  expect(info.audioTracks).toHaveLength(0);
});

test('a video that does not get smaller is still offered, with a note', async ({ page }) => {
  await open(page);
  await choose(page, TINY);
  await page.getByRole('radio', { name: 'Better quality' }).check();
  await compress(page);
  await expect(page.locator('[data-video-notes]')).toHaveText('This video was already well compressed.');
  const { name } = await download(page);
  expect(name).toBe('well-compressed-compressed.mp4');
});

test('no VideoEncoder: the browser cannot encode video', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { VideoEncoder?: unknown }).VideoEncoder;
  });
  await open(page);
  await expect(page.getByText(NO_ENCODE)).toBeVisible();
  await expect(page.locator('.drop')).toBeHidden();
});

test('longer than 2 minutes: the limits', async ({ page }) => {
  await open(page);
  await fileInput(page).setInputFiles(LONG);
  await expect(alertText(page)).toHaveText(LIMITS);
  await expect(compressBtn(page)).toBeHidden();
});

test('larger than 200 MB: the limits, before the file is read', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('[data-kind="video"] input[type=file]')!;
    const file = new File([new Uint8Array(16)], 'big.mp4', { type: 'video/mp4' });
    Object.defineProperty(file, 'size', { value: 200_000_001 }); // the metadata says so; no 200 MB in the test
    // The island reads the File it is given: hand it this one.
    Object.defineProperty(input, 'files', { value: { 0: file, length: 1, item: () => file }, configurable: true });
    input.dispatchEvent(new Event('change'));
  });
  await expect(alertText(page)).toHaveText(LIMITS);
});

test('a portrait phone video: shown as 360 × 640, and the MP4 keeps its quarter turn', async ({ page }) => {
  await open(page);
  await choose(page, ROTATED);
  await expect(page.locator('[data-video-file]')).toContainText('360 × 640 · 0:01');
  await compress(page);
  const info = mp4Info((await download(page)).bytes);
  const video = info.videoTracks[0]!;
  expect(video.video).toEqual({ width: 640, height: 360 }); // stored as it was
  expect(rotationOf(video.matrix as unknown as ArrayLike<number>)).toBe(90); // tkhd: turned a quarter clockwise
});

test("a codec this browser can't decode: try another browser (not the unsupported-format copy)", async ({ page }) => {
  // The decoder check runs in the worker, where init scripts don't: patch the worker script as it is served.
  await page.context().route('**/_astro/worker-*.js', async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    const patch = body.includes('VideoDecoder') && body.includes('isConfigSupported');
    await route.fulfill({
      response: res,
      body: patch ? `self.VideoDecoder.isConfigSupported = async () => ({ supported: false });\n${body}` : body,
    });
  });
  await open(page);
  await fileInput(page).setInputFiles(CLIP);
  await expect(alertText(page)).toHaveText(UNDECODABLE);
});

test('WebM: not supported yet', async ({ page }) => {
  await open(page);
  await fileInput(page).setInputFiles(WEBM);
  await expect(alertText(page)).toHaveText(UNSUPPORTED);
});

test('a damaged MP4', async ({ page }) => {
  await open(page);
  await fileInput(page).setInputFiles(TRUNCATED);
  await expect(alertText(page)).toHaveText(DAMAGED);
});

test('a photo: wrong type, with a way to the image tool', async ({ page }) => {
  await open(page);
  await fileInput(page).setInputFiles('tests/fixtures/photo.jpg');
  await expect(alertText(page)).toHaveText('This is a JPG, not a video.');
  await expect(page.getByRole('link', { name: 'Try Compress image →' })).toHaveAttribute('href', '/compress-image/');
});

test('Cancel stops the work and goes back to the file; Start over goes back to the start', async ({ page }) => {
  await installResultHold(page);
  await open(page);
  await choose(page, CLIP);
  await holdResults(page); // the result waits, so Cancel is there to press however fast the encoder is
  await compressBtn(page).click();
  await expect(page.getByText(/^Compressing… \d+%$/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(compressBtn(page)).toBeVisible();
  await expect(page.locator('[data-video-panel]')).toBeHidden();
  // It still works after a cancel (a fresh worker).
  await page.evaluate(() => ((window as unknown as { __hold: boolean }).__hold = false));
  await compress(page);
  await page.getByRole('button', { name: 'Start over' }).click();
  await expect(page.getByText('Drop a video here')).toBeVisible();
  await expect(compressBtn(page)).toBeHidden();
});
