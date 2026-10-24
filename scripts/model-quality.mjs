// Manual model-quality checks (spec §5.3). NOT part of CI or `npm test`: it downloads the real models.
// Run with `npm run test:models`. It builds the site WITHOUT the test stubs, serves that build locally, and drives the
// real pages in Chromium (Playwright), so the real downloads, runtimes and inference run exactly as a visitor's would:
//   1. Remove background on 3 photos: writes the PNGs to review/model-quality/ for you to look at (no pass/fail).
//   2. Image to text on a receipt-like image: word accuracy >= 90%.
//   3. Transcribe audio on a ~10 s English clip: word error rate <= 15%.
// Environment (all optional):
//   MODEL_QUALITY_ONLY      a comma-separated subset of `bg,ocr,whisper` to run (default: all three).
//   PUBLIC_MODEL_BASE_URL   where models come from (default: the site's default host, Hugging Face). Same pinned paths.
//   MODEL_QUALITY_PHOTOS    a folder with at least 3 .jpg/.png photos with a clear subject (default: the synthetic
//                           repo fixtures, which only prove the pipeline runs, not that cut-outs look good).
//   MODEL_QUALITY_AUDIO     a 16-bit WAV of about 10 s of English speech, with MODEL_QUALITY_AUDIO_TEXT its words.
//                           Default: macOS `say` reads a fixed sentence (needs `say` and `afconvert`, i.e. macOS).
// Downloaded models are cached by the browser profile of this run only, and are never written into the repo.
import { execFileSync, execSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const OUT = 'dist-model-quality';
const REVIEW = 'review/model-quality';
const OCR_MIN_ACCURACY = 0.9;
const WER_MAX = 0.15;
const DOWNLOAD_TIMEOUT = 15 * 60_000;

const RECEIPT_LINES = [
  'CORNER MARKET',
  '12 High Street',
  'Date 24 October 2026',
  'Bread 2.50',
  'Milk 1.20',
  'Apples 3.75',
  'Coffee beans 8.99',
  'Subtotal 16.44',
  'Tax 1.64',
  'Total 18.08',
  'Thank you for shopping with us',
];
const SPEECH = 'The quick brown fox jumps over the lazy dog. Please call Stella and ask her to bring these things with her from the store. We also need a loaf of bread, two bottles of milk and a dozen fresh eggs.';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
};

/** Lower-case words with punctuation dropped: "$4.50," becomes "450". */
const words = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);

/** Word-level edit distance (substitutions, insertions, deletions). */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}
const wordErrorRate = (reference, hypothesis) => {
  const ref = words(reference);
  return editDistance(ref, words(hypothesis)) / ref.length;
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
/** A static server for the build: `/slug/` is `/slug/index.html`. */
function serve(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = resolve(dir, `.${path}`);
    if (!file.startsWith(resolve(dir))) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

function photos() {
  const dir = process.env.MODEL_QUALITY_PHOTOS;
  if (dir) {
    const found = readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().slice(0, 3).map((f) => join(dir, f));
    if (found.length < 3) throw new Error(`MODEL_QUALITY_PHOTOS needs at least 3 .jpg or .png photos, found ${found.length}`);
    return found;
  }
  console.warn('note: MODEL_QUALITY_PHOTOS is not set, so the repo fixtures are used. They are synthetic: set it to a folder of real photos for a meaningful visual check.');
  return ['tests/fixtures/photo.jpg', 'tests/fixtures/rotated-6.jpg', 'tests/fixtures/alpha.png'];
}

function speech(workDir) {
  if (process.env.MODEL_QUALITY_AUDIO) {
    const text = process.env.MODEL_QUALITY_AUDIO_TEXT;
    if (!text) throw new Error('MODEL_QUALITY_AUDIO needs MODEL_QUALITY_AUDIO_TEXT: the words spoken in it');
    return { file: process.env.MODEL_QUALITY_AUDIO, text };
  }
  if (process.platform !== 'darwin') throw new Error('No clip: set MODEL_QUALITY_AUDIO and MODEL_QUALITY_AUDIO_TEXT (the default clip is made with macOS `say`)');
  const aiff = join(workDir, 'speech.aiff');
  const wav = join(workDir, 'speech.wav');
  execFileSync('say', ['-v', 'Samantha', '-r', '170', '-o', aiff, SPEECH]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', aiff, wav]);
  return { file: wav, text: SPEECH };
}
const wavSeconds = (file) => (statSync(file).size - 44) / 32_000; // 16 kHz, 16-bit, mono

async function removeBackground(context, origin) {
  mkdirSync(REVIEW, { recursive: true });
  for (const [i, photo] of photos().entries()) {
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/remove-background/`);
      await page.locator('[data-kind="ai"] input[type=file]').setInputFiles(photo);
      const download = page.getByRole('button', { name: 'Download PNG' });
      await download.waitFor({ state: 'visible', timeout: DOWNLOAD_TIMEOUT });
      await page.waitForFunction(() => !document.querySelector('[data-ai-panel]:not([hidden])'), null, { timeout: DOWNLOAD_TIMEOUT });
      const [saved] = await Promise.all([page.waitForEvent('download'), download.click()]);
      const out = join(REVIEW, `${i + 1}-${saved.suggestedFilename()}`);
      await saved.saveAs(out);
      record(`remove background: ${photo}`, true, `wrote ${out}: look at it (subject kept, background gone, clean edges)`);
    } catch (err) {
      record(`remove background: ${photo}`, false, String(err.message ?? err).split('\n')[0]);
    } finally {
      await page.close();
    }
  }
}

async function ocr(context, origin, workDir) {
  const receipt = join(workDir, 'receipt.png');
  const draw = await context.newPage();
  const html = `<body style="margin:0;background:#fff"><pre style="margin:0;padding:32px;width:640px;font:26px/1.5 'Courier New',monospace;color:#111">${RECEIPT_LINES.join('\n')}</pre></body>`;
  await draw.setViewportSize({ width: 704, height: 600 });
  await draw.setContent(html);
  writeFileSync(receipt, await draw.locator('pre').screenshot());
  await draw.close();

  const page = await context.newPage();
  try {
    await page.goto(`${origin}/image-to-text/`);
    await page.locator('[data-kind="ai"] input[type=file]').setInputFiles(receipt);
    const box = page.getByRole('textbox', { name: 'Text' });
    await box.waitFor({ state: 'visible', timeout: DOWNLOAD_TIMEOUT });
    const text = await box.inputValue();
    const accuracy = Math.max(0, 1 - wordErrorRate(RECEIPT_LINES.join('\n'), text));
    record('image to text: receipt', accuracy >= OCR_MIN_ACCURACY, `word accuracy ${(accuracy * 100).toFixed(1)}% (need ${OCR_MIN_ACCURACY * 100}%)`);
    if (accuracy < OCR_MIN_ACCURACY) console.log(`      read:\n${text.replace(/^/gm, '        ')}`);
  } catch (err) {
    record('image to text: receipt', false, String(err.message ?? err).split('\n')[0]);
  } finally {
    await page.close();
  }
}

async function whisper(context, origin, workDir) {
  const page = await context.newPage();
  try {
    const clip = speech(workDir);
    const seconds = wavSeconds(clip.file);
    console.log(`      clip: ${clip.file}, ${seconds.toFixed(1)} s`);
    await page.goto(`${origin}/transcribe-audio/`);
    await page.locator('[data-kind="ai"] input[type=file]').setInputFiles(clip.file);
    const consent = page.getByRole('button', { name: 'Download and start' });
    const box = page.getByRole('textbox', { name: 'Transcript' });
    // The 80 MB model asks first. Then the transcript appears and fills in.
    await consent.or(box).waitFor({ state: 'visible', timeout: 60_000 });
    if (await consent.isVisible()) await consent.click();
    await box.waitFor({ state: 'visible', timeout: DOWNLOAD_TIMEOUT });
    await page.waitForFunction(() => !document.querySelector('[data-ai-panel]:not([hidden])'), null, { timeout: DOWNLOAD_TIMEOUT });
    const text = await box.inputValue();
    const wer = wordErrorRate(clip.text, text);
    record('transcribe audio: English clip', wer <= WER_MAX, `WER ${(wer * 100).toFixed(1)}% (need <= ${WER_MAX * 100}%)`);
    if (wer > WER_MAX) console.log(`      heard: ${text}\n      said:  ${clip.text}`);
  } catch (err) {
    record('transcribe audio: English clip', false, String(err.message ?? err).split('\n')[0]);
  } finally {
    await page.close();
  }
}

async function main() {
  const env = { ...process.env };
  delete env.PUBLIC_AI_STUB; // the real models, not the test stand-ins
  delete env.PUBLIC_PLAUSIBLE_DOMAIN; // no analytics from a quality run
  console.log(`Building the site without stubs into ${OUT}/ (models from ${env.PUBLIC_MODEL_BASE_URL || 'the default host'})…`);
  execSync(`npx astro build --outDir ${OUT}`, { stdio: 'inherit', env });

  const workDir = mkdtempSync(join(tmpdir(), 'model-quality-'));
  const { server, origin } = await serve(OUT);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    console.log('Models download on first use and can take a few minutes.');
    const only = (process.env.MODEL_QUALITY_ONLY ?? 'bg,ocr,whisper').split(',').map((n) => n.trim());
    if (only.includes('bg')) await removeBackground(context, origin);
    if (only.includes('ocr')) await ocr(context, origin, workDir);
    if (only.includes('whisper')) await whisper(context, origin, workDir);
  } finally {
    await browser.close();
    server.close();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(OUT, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\nFAIL: ${failed.length} of ${results.length} checks failed.` : `\nPASS: all ${results.length} checks passed.${results.some((r) => r.name.startsWith('remove background')) ? ` Now look at the PNGs in ${REVIEW}/.` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
