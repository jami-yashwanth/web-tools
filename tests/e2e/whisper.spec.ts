import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { WHISPER_BYTES, WHISPER_FILES, WHISPER_GPU_BYTES, WHISPER_GPU_FILES } from '../../src/ai/whisper/files';
import { routeModels } from './models';
import { clearPanelSeen, panelExtraSeen, panelSeen, recordPanel } from './panel';
import { stubPlausible } from './plausible';
import { tone, wav } from './wav';

// Transcribe audio, and with it the shared AI states that need a model over 20 MB: the consent screen, the mobile
// data line, Cancel back to consent. In the E2E build (PUBLIC_AI_STUB=1) the model's files really download through
// the shared loader (routed bytes of each file's real size), and decoding and resampling are the browser's own; only
// the model's inference is faked: each 30 s window with sound reads "This is a test transcript.", silence reads
// nothing.

const HELLO = 'tests/fixtures/audio/hello.wav'; // 2 s, 44.1 kHz stereo
const SILENCE = 'tests/fixtures/audio/silence.wav';
const STUB_TEXT = 'This is a test transcript.';
const FAILED = "Couldn't download the AI model. Check your connection.";
const SLOW = 'This will be slow on this device (about as long as the audio).';
const CELLULAR = 'You seem to be on mobile data.';
const NO_SPEECH = "We couldn't hear any speech in this file.";

const require_ = createRequire(import.meta.url);
const size = (spec: string) => statSync(require_.resolve(spec)).size;
const WASM_RUNTIME = size('onnxruntime-web/ort-wasm-simd-threaded.wasm'); // same origin, not routed
const WEBGPU_RUNTIME = size('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm'); // from the model host
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const consentText = (bytes: number) => `This tool downloads a ${mb(bytes)} AI model the first time. It's cached for next time.`;

/** Each routed file's real size: a Whisper file (of either set), or the WebGPU runtime. */
const ALL_FILES = { ...WHISPER_FILES, ...WHISPER_GPU_FILES };
const routedSize = (url: string) => {
  const name = Object.keys(ALL_FILES).find((f) => url.endsWith(`/${f}`));
  if (name) return ALL_FILES[name]!.bytes;
  if (url.endsWith('/ort-wasm-simd-threaded.asyncify.wasm')) return WEBGPU_RUNTIME;
  throw new Error(`unexpected model request ${url}`);
};

async function open(page: Page, { cellular = false, webgpu = false } = {}) {
  await stubPlausible(page.context());
  await recordPanel(page);
  if (cellular) await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { type: 'cellular' } }));
  // WebGPU as asked, whatever the test browser has (Playwright's WebKit on a Mac has a real adapter).
  if (webgpu) {
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } }),
    );
  } else {
    await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  }
  const models = await routeModels(page, routedSize);
  await page.goto('/transcribe-audio/');
  return models;
}
const choose = (page: Page, file: string | { name: string; mimeType: string; buffer: Buffer } = HELLO) =>
  page.locator('[data-kind="ai"] input[type=file]').setInputFiles(file);
const panel = (page: Page) => page.locator('[data-ai-panel]');
const consent = (page: Page) => page.getByRole('button', { name: 'Download and start' });
const transcript = (page: Page) => page.getByRole('textbox', { name: 'Transcript' });
const modelCached = (page: Page) =>
  page.evaluate(async () => (await (await caches.open('models-v1')).keys()).some((r) => r.url.includes('/test-models/')));
const onnxCached = (page: Page) =>
  page.evaluate(async () => (await (await caches.open('models-v1')).keys()).some((r) => r.url.endsWith('.onnx')));
/** A WAV of `seconds` of tone (8 kHz, 8-bit: small even when long). */
const toneWav = (name: string, seconds: number) => ({ name, mimeType: 'audio/wav', buffer: wav([tone(seconds, 8_000)], 8_000, 8) });

test('the consent screen shows the computed size (model and runtime) and downloads nothing until asked', async ({ page }) => {
  const models = await open(page);
  await choose(page);
  await expect(consent(page)).toBeFocused();
  expect(mb(WHISPER_BYTES)).toBe('80 MB');
  await expect(panel(page).locator('p').first()).toHaveText(consentText(WHISPER_BYTES + WASM_RUNTIME));
  await expect(page.getByText(CELLULAR)).toBeHidden();
  expect(models.requests).toBe(0);

  await consent(page).click();
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
  expect(models.requests).toBe(Object.keys(WHISPER_FILES).length);
});

test('on mobile data the consent screen says so', async ({ page }) => {
  await open(page, { cellular: true });
  await choose(page);
  await expect(consent(page)).toBeVisible();
  await expect(panel(page).getByText(CELLULAR, { exact: true })).toBeVisible();
});

test('Download and start shows the download; Cancel goes back to the consent screen and caches nothing', async ({ page }) => {
  const models = await open(page);
  models.mode = 'slow';
  await choose(page);
  await consent(page).click();
  const total = WHISPER_BYTES + WASM_RUNTIME;
  await expect(panel(page).locator('p').first()).toHaveText(new RegExp(`^Downloading the AI model… [1-9]\\d* of ${mb(total)}, one time only$`));
  const bar = panel(page).locator('progress');
  expect(Number(await bar.getAttribute('max'))).toBe(total);
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(consent(page)).toBeFocused();
  await expect(panel(page).locator('p').first()).toHaveText(consentText(total));
  // Files that finished before Cancel stay cached (the next try downloads less); the model itself is not in.
  expect(await onnxCached(page)).toBe(false);

  models.mode = 'serve';
  await consent(page).click();
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
});

test('a failed download says so, and Try again downloads and transcribes', async ({ page }) => {
  const models = await open(page);
  models.mode = 'abort';
  await choose(page);
  await consent(page).click();
  await expect(page.getByRole('alert').getByText(FAILED, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeFocused();
  models.mode = 'serve';
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
});

const otherFile = (page: Page) => page.getByRole('button', { name: 'Choose another file' });
const dropZone = (page: Page) => page.locator('[data-kind="ai"] .drop');

test('the consent screen offers Choose another file: back to the drop zone, nothing downloaded', async ({ page }) => {
  const models = await open(page);
  await choose(page);
  await expect(consent(page)).toBeFocused();
  await otherFile(page).click();
  await expect(dropZone(page)).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('[data-kind="ai"] input[type=file]')).toBeFocused();
  expect(models.requests).toBe(0);
  // The same file again: read afresh, and asked about again.
  await choose(page);
  await expect(consent(page)).toBeFocused();
});

test('a failed download offers Choose another file as well as Try again', async ({ page }) => {
  const models = await open(page);
  models.mode = 'abort';
  await choose(page);
  await consent(page).click();
  await expect(page.getByRole('alert').getByText(FAILED, { exact: true })).toBeVisible();
  await page.getByRole('alert').getByRole('button', { name: 'Choose another file' }).click();
  await expect(dropZone(page)).toBeVisible();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(panel(page)).toBeHidden();
  models.mode = 'serve';
  await choose(page);
  await consent(page).click();
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
});

test('Reading audio… offers Choose another file, which stops the reading', async ({ page }) => {
  await open(page);
  await choose(page, toneWav('long.wav', 25 * 60)); // 25 min: a moment to decode
  await expect(panel(page).locator('p').first()).toHaveText('Reading audio…');
  await otherFile(page).click();
  await expect(dropZone(page)).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await page.waitForTimeout(1_000); // the reading it stopped never comes back with a consent screen
  await expect(panel(page)).toBeHidden();
});

test('a model that fails to parse is dropped from the cache and shown as a failed download', async ({ page }) => {
  const models = await open(page);
  models.mode = 'bad';
  await choose(page);
  await consent(page).click();
  await expect(page.getByRole('alert').getByText(FAILED, { exact: true })).toBeVisible();
  expect(await modelCached(page)).toBe(false);
  models.mode = 'serve';
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
});

test('after one successful download the consent screen is skipped and nothing downloads again', async ({ page }) => {
  const models = await open(page);
  await choose(page);
  await consent(page).click();
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
  const requests = models.requests;

  await page.getByRole('button', { name: 'Start over' }).click();
  await clearPanelSeen(page);
  await choose(page);
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
  expect((await panelSeen(page)).some((t) => t.startsWith('This tool downloads') || t.startsWith('Downloading'))).toBe(false);
  expect(models.requests).toBe(requests);
});

test('after one successful download, a reload skips the consent screen', async ({ page, browserName }) => {
  // Playwright's WebKit keeps Cache Storage in memory per page, so a reload empties it (see ai-shared.spec.ts).
  test.skip(browserName === 'webkit', 'Playwright WebKit drops Cache Storage on reload');
  const models = await open(page);
  await choose(page);
  await consent(page).click();
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
  const requests = models.requests;
  await page.reload();
  await choose(page);
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
  expect((await panelSeen(page)).some((t) => t.startsWith('This tool downloads'))).toBe(false);
  expect(models.requests).toBe(requests);
});

test('working shows "Transcribing… n%" with the transcript as it comes, and the slow note without WebGPU', async ({ page }) => {
  await open(page);
  await choose(page, toneWav('talk.wav', 65)); // three 30 s windows
  await consent(page).click();
  await expect(transcript(page)).toHaveValue(`${STUB_TEXT} ${STUB_TEXT} ${STUB_TEXT}`);
  const seen = await panelSeen(page);
  expect(seen.some((t) => /^Transcribing… \d+%$/.test(t))).toBe(true);
  const extra = await panelExtraSeen(page);
  expect(extra).toContain(SLOW);
  // The transcript shows while it is made: one window's text before the rest.
  expect(extra).toContain(STUB_TEXT);
  expect(extra).toContain(`${STUB_TEXT} ${STUB_TEXT}`);
});

test('with WebGPU on a computer: its own model files and the WebGPU runtime, counted in the size, and no slow note', async ({ page }) => {
  const models = await open(page, { webgpu: true });
  await choose(page);
  await expect(panel(page).locator('p').first()).toHaveText(consentText(WHISPER_GPU_BYTES + WEBGPU_RUNTIME));
  await consent(page).click();
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
  expect(models.requests).toBe(Object.keys(WHISPER_GPU_FILES).length + 1);
  expect(await panelExtraSeen(page)).not.toContain(SLOW);
});

test('Copy, and the .txt, .srt and .vtt downloads hold the transcript with its timings', async ({ page, context, browserName }) => {
  await open(page);
  await choose(page);
  await consent(page).click();
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
  await expect(transcript(page)).toHaveAttribute('readonly', '');

  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Copied')).toBeVisible();
  if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(STUB_TEXT);

  const expected: Record<string, string> = {
    txt: STUB_TEXT,
    srt: `1\n00:00:00,000 --> 00:00:02,000\n${STUB_TEXT}\n\n`,
    vtt: `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${STUB_TEXT}\n\n`,
  };
  for (const ext of ['txt', 'srt', 'vtt']) {
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: `Download .${ext}` }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`hello.${ext}`);
    expect(readFileSync(await download.path(), 'utf8')).toBe(expected[ext]);
  }
});

test('silence: no speech, no downloads of any kind, and no consent', async ({ page }) => {
  const models = await open(page);
  await choose(page, SILENCE);
  await expect(page.getByText(NO_SPEECH, { exact: true })).toBeVisible();
  for (const name of ['Copy', 'Download .txt', 'Download .srt', 'Download .vtt']) await expect(page.getByRole('button', { name })).toHaveCount(0);
  await expect(consent(page)).toHaveCount(0);
  expect(models.requests).toBe(0);
});

test('over 30 minutes: "Audio up to 30 minutes for now.", before any download', async ({ page }) => {
  const models = await open(page);
  await choose(page, { name: 'long.wav', mimeType: 'audio/wav', buffer: wav([new Float32Array(31 * 60 * 8_000)], 8_000, 8) });
  await expect(page.getByRole('alert').getByText('Audio up to 30 minutes for now.', { exact: true })).toBeVisible();
  await expect(consent(page)).toHaveCount(0);
  await expect(page.locator('.drop')).toBeVisible();
  expect(models.requests).toBe(0);
});

test('an image says what it is; a damaged file says so', async ({ page }) => {
  await open(page);
  await choose(page, 'tests/fixtures/photo.jpg');
  await expect(page.getByRole('alert').getByText('This is a JPG, not an audio or video file.', { exact: true })).toBeVisible();
  await choose(page, { name: 'broken.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('this is not audio at all, only text') });
  await expect(page.getByRole('alert').getByText("We couldn't read this file. It may be damaged or incomplete.", { exact: true })).toBeVisible();
  await expect(consent(page)).toHaveCount(0);
});

test('Cancel while transcribing stops it and goes back to the drop zone', async ({ page }) => {
  await open(page);
  await choose(page);
  await consent(page).click();
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
  await page.getByRole('button', { name: 'Start over' }).click();
  // A long file, so it is still working when Cancel is pressed.
  await choose(page, toneWav('long-talk.wav', 29 * 60));
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(panel(page).locator('p').first()).toHaveText(/^Transcribing… \d+%$/);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.drop')).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('[data-kind="ai"] input[type=file]')).toBeFocused();
});

/** Make decoding take `ms` longer, so the page's state while it decodes can be seen. */
const slowDecode = (page: Page, ms: number) =>
  page.addInitScript((delay) => {
    const decode = OfflineAudioContext.prototype.decodeAudioData;
    OfflineAudioContext.prototype.decodeAudioData = function (this: OfflineAudioContext, data: ArrayBuffer) {
      return new Promise((r) => setTimeout(r, delay)).then(() => decode.call(this, data));
    } as typeof decode;
  }, ms);

test('over 300 MB: "Files up to 300 MB for now. Try a shorter recording.", without reading the file', async ({ page }) => {
  // A small file that says it is 301 MB: the cap is checked from the size alone.
  await page.addInitScript(() => {
    const size = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
    Object.defineProperty(Blob.prototype, 'size', {
      get(this: Blob) {
        return this instanceof File && this.name === 'huge.wav' ? 301_000_000 : size.call(this);
      },
    });
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function (this: Blob) {
      if (this instanceof File && this.name === 'huge.wav') (window as unknown as { readHuge: boolean }).readHuge = true;
      return read.call(this);
    };
  });
  const models = await open(page);
  await choose(page, { name: 'huge.wav', mimeType: 'audio/wav', buffer: readFileSync(HELLO) });
  await expect(page.getByRole('alert').getByText('Files up to 300 MB for now. Try a shorter recording.', { exact: true })).toBeVisible();
  await expect(page.locator('.drop')).toBeVisible();
  await expect(consent(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { readHuge?: boolean }).readHuge)).toBeUndefined();
  expect(models.requests).toBe(0);
});

test('while decoding: "Reading audio…" with a bar that just runs; a newer file replaces the one still decoding', async ({ page }) => {
  await slowDecode(page, 1500);
  await open(page);
  await choose(page, toneWav('first.wav', 65));
  await expect(panel(page).locator('p').first()).toHaveText('Reading audio…');
  const bar = panel(page).locator('progress');
  await expect(bar).toBeVisible();
  expect(await bar.getAttribute('value')).toBeNull(); // indeterminate
  // A second file while the first still decodes: only the second goes on.
  await choose(page);
  await expect(consent(page)).toBeVisible();
  await consent(page).click();
  await expect(transcript(page)).toHaveValue(STUB_TEXT); // hello.wav's one window, not first.wav's three
  await page.waitForTimeout(1600); // the first decode ends now: it must change nothing
  await expect(transcript(page)).toHaveValue(STUB_TEXT);
  await expect(consent(page)).toHaveCount(0);
});
