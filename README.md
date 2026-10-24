# web-tools

Free tools that run entirely in the browser. Files are decoded, converted and re-encoded on the visitor's device and nothing is uploaded. It is a static Astro site with one page per tool, built for search and for speed (under 15 KB of gzip JavaScript before a file is dropped).

## Tools

- Image: HEIC to JPG, WebP to JPG, Compress image (location metadata is stripped; batches download as one ZIP).
- PDF: Merge PDF, Split PDF, PDF to JPG, JPG to PDF.
- Developer and QR: JSON formatter, Base64 encode/decode, JWT decoder, QR code generator.
- Round 3, on-device AI: Remove background (U²-Net small), Image to text (tesseract.js), Upscale image (Real-ESRGAN), Transcribe audio (Whisper base). Models download on first use.
- Round 3, video (the browser's own WebCodecs, no model): Compress video, Video to GIF.

## Requirements

- Node 22.23.4 or newer (Astro's minimum). `.nvmrc` pins 24, which CI and Cloudflare Pages both read.
- To generate test fixtures: macOS (needs `sips`) plus `brew install exiftool webp libheif imagemagick`. CI uses a macOS runner for the same reason.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Astro dev server |
| `npm run build` | Static build into `dist/` |
| `npm run preview` | Serve `dist/` |
| `npm run fixtures` | Generate `tests/fixtures/*` (the two large files, `iphone-48mp.heic` and `huge-63mp.jpg`, are gitignored and only exist after this) |
| `npm test` | Vitest unit tests (includes a real build and checks of its output) |
| `npm run typecheck` | `astro check` |
| `npm run check:budget` | Fails if a tool page loads more than 15 KB gzip JS before a file is dropped (run after `build`) |
| `npm run test:e2e` | Playwright on chromium, webkit and firefox. It builds and serves the site itself on port 4399, with `PUBLIC_AI_STUB=1` (see below) |
| `npm run test:models` | Manual, not in CI: downloads the real models and checks their quality (see "Model quality check") |

CI (`.github/workflows/ci.yml`) runs the whole gate on every push: fixtures, unit tests, typecheck, build, budget, then Playwright. The Playwright report is uploaded when a run fails.

## How it is built

- `src/engine/` is the conversion engine. The page talks to a Web Worker through `client.ts`; the worker (`worker.ts`) sniffs the real file type (`sniff.ts`), decodes (`decode.ts`), fixes orientation, converts and encodes (`convert.ts`, `pixels.ts`). `codecs.ts` lazy-loads each WASM codec on first use, and `types.ts` holds the limits (`MAX_MEGAPIXELS`, `DOWNSCALE_MEGAPIXELS`).
- `src/ui/` is the drop zone, file rows, size formatting and ZIP building. It is vanilla TypeScript, no framework.
- `src/tools.ts` is the tool registry: one entry per tool holds the title, copy, FAQ, accepted types, outputs, defaults and related tools.
- `src/pages/[tool].astro` renders every registry entry into a static page with its JSON-LD; `index.astro` and `licenses.astro` are the other pages.

### Add a tool

1. Add an entry to `TOOLS` in `src/tools.ts` (and its slug to `ToolSlug`). Reuse the existing fields: `accepts`, `outputs`, `defaults`, `faq`, `related`.
2. Only if it reads or writes a format that is not already supported, add a codec in `src/engine/codecs.ts` and the matching decode/encode path in `src/engine/`, plus a sniff case in `sniff.ts` and a fixture in `scripts/make-fixtures.sh`.
3. Add its codec to the licences list in `src/pages/licenses.astro` if it brings a new dependency.
4. `npm test` and `npx playwright test`. The build-output test covers every registry entry automatically.

## Privacy

Files never leave the device: the only network requests during a conversion are same-origin GETs for the site's own pages and codecs, and, for the AI tools, bare GETs (no body, no query string) for model files from the model host. Analytics is optional (set `PUBLIC_PLAUSIBLE_DOMAIN`) and sends only an event name plus `tool`, `count` or `reason`: never file names, sizes or content. Without the variable, the build contains no Plausible markup.

Enforced by tests:

- `tests/e2e/privacy.spec.ts` watches every request during a real 3-file batch and ZIP download in all three engines. It asserts that every request is a same-origin GET or a Plausible event, that no URL or body contains a file name or the first bytes of a fixture, and that events carry only the allowed props.
- The same file covers every round 3 page (the AI tools and the video tools): one `convert_success {tool, count}` per finished job, one `convert_error {tool, reason}` per failure the user sees (Cancel included, as `cancelled`), with the file name, the file's first bytes, the OCR text and the transcript absent from every URL and body, and model-host requests checked to be GETs with no body.
- `tests/unit/build-output.test.ts` asserts that a build without `PUBLIC_PLAUSIBLE_DOMAIN` ships no Plausible markup, that a production build contains no test-stub code, that no file in `dist/` is over the 25 MB Cloudflare Pages cap, and that `/licenses/` lists every dependency in `package.json` and every model in `MODELS` (`src/ai/config.ts`).

Error reasons sent to Plausible come from one list: `network | cancelled | unsupported | too-large | too-long | corrupt | wrong-type | device | encrypted` (plus `range`, from Split PDF's page-range check).

## AI tools and model hosting

The models are not in `dist/` (Cloudflare Pages caps a file at 25 MB). Every model URL is `${PUBLIC_MODEL_BASE_URL}/<path>`, and the paths and sizes live in one table, `MODELS` in `src/ai/config.ts`. Two things ship with the site instead: the tesseract.js `eng` language data (`public/models/tessdata/`, 2 MB) and onnxruntime-web's WebAssembly runtime (14 MB), both same-origin.

Without `PUBLIC_MODEL_BASE_URL` the default host is Hugging Face, which works for development but has no WebGPU runtime: Transcribe audio then runs on WebAssembly only. For launch, host the files yourself:

1. Create a Cloudflare R2 bucket and make it publicly readable (a custom domain on the bucket, or the r2.dev URL for testing). Add a CORS rule allowing `GET` from the site's origin (the pages fetch the files with `fetch`), with `"ExposeHeaders": ["Content-Length", "Content-Encoding"]`: the loader reads `Content-Encoding` to know whether `Content-Length` is the size it will receive, and a cross-origin page can't see it unless the bucket exposes it. For example: `[{"AllowedOrigins": ["https://example.com"], "AllowedMethods": ["GET"], "ExposeHeaders": ["Content-Length", "Content-Encoding"], "MaxAgeSeconds": 86400}]`.
2. Upload each file at the exact path below, under the bucket root. Paths are pinned to commits, so the files must be those exact revisions (their sha256 are on `/licenses/`):
   - `BritishWerewolf/U-2-Netp/resolve/7112208dbac3a3642496c8d54e2f0f9bb3dc1dc8/onnx/model.onnx` (Remove background, 4.6 MB)
   - `vlad-grig/realesr-general-x4v3-onnx/resolve/0e95d93e454cf6b5de9bdf5a1c9e7ec340d38231/onnx/model.onnx` (Upscale image, 4.9 MB)
   - `onnxruntime-web/1.30.0/ort-wasm-simd-threaded.asyncify.wasm`: a copy of `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm` at version 1.30.0, the WebGPU runtime (27 MB, over the Pages cap)
   - `Xenova/whisper-base/resolve/64da57285918e20ea79ea5c88eed7197933abaa8/` plus each file of `src/ai/whisper/files.ts`: `config.json`, `generation_config.json`, `preprocessor_config.json`, `tokenizer.json`, `tokenizer_config.json`, and the encoder and decoder in both sets, `onnx/encoder_model_q4f16.onnx` and `onnx/decoder_model_merged_q4f16.onnx` (WebGPU) and `onnx/encoder_model_quantized.onnx` and `onnx/decoder_model_merged_quantized.onnx` (WebAssembly, for browsers without WebGPU)
3. Set `PUBLIC_MODEL_BASE_URL` in the Cloudflare Pages environment to an absolute `https://` URL (for example `https://models.example.com`, no trailing slash). A relative path or an `http://` URL is not supported: model URLs are built as `${PUBLIC_MODEL_BASE_URL}/<path>` and fetched from the tools' workers, and an https page can't fetch over plain http. Setting it is also what turns on WebGPU for Transcribe audio, because only your bucket has the WebGPU runtime.
4. Run `npm run test:models` against it (below).

### Tests and the stub build

Playwright builds with `PUBLIC_AI_STUB=1` and `PUBLIC_MODEL_BASE_URL=http://localhost:4399/test-models`. In that build the Remove background, Upscale and Transcribe workers return deterministic fake outputs, and the tests answer the model requests with generated bytes of the real size (`tests/e2e/models.ts`), so no model is ever downloaded or committed. Image to text is not stubbed: it runs the real tesseract.js with the real `eng` model (`tests/fixtures/models/tessdata/`). A production build contains none of the stub code, which a unit test checks.

### Model quality check (manual)

`npm run test:models` (`scripts/model-quality.mjs`) is for a person to run before launch and whenever a model or its URL changes. It is not part of CI or `npm test`. It builds the site without stubs into `dist-model-quality/` (deleted afterwards), serves it locally, and drives the real pages in Playwright's Chromium, so the real downloads from `PUBLIC_MODEL_BASE_URL` (or the default host) and the real inference run. It needs `npx playwright install chromium` once, and a first run downloads about 100 MB of models; nothing it downloads goes into the repo. It prints PASS or FAIL per check and exits non-zero on a failure:

- Remove background on 3 photos: writes the PNGs to `review/model-quality/` (gitignored) for you to look at. There is no automatic pass mark; open them and check the subject is kept and the edges are clean.
- Image to text on a receipt-like image the script draws itself: word accuracy of at least 90%.
- Transcribe audio on a clip of about 10 s of English speech: word error rate of at most 15%.

`test:models` runs Whisper on WebAssembly only: Playwright's Chromium is headless and has no WebGPU adapter, so the WebGPU path (the q4f16 files and the WebGPU runtime from your bucket) is never exercised by it. Check that path by hand in a headed browser with WebGPU (desktop Chrome or Edge): transcribe a real clip on the deployed site, and confirm in DevTools (Network) that `encoder_model_q4f16.onnx` and `ort-wasm-simd-threaded.asyncify.wasm` were downloaded and that no "slow on this device" note was shown.

Inputs: `MODEL_QUALITY_PHOTOS=<folder with 3+ real .jpg or .png photos>` (without it the synthetic repo fixtures are used, which only prove the pipeline runs); `MODEL_QUALITY_AUDIO=<16-bit WAV>` with `MODEL_QUALITY_AUDIO_TEXT="<its words>"` (without them, on macOS, `say` reads a fixed sentence). Example: `PUBLIC_MODEL_BASE_URL=https://models.example.com MODEL_QUALITY_PHOTOS=~/photos npm run test:models`.

## Launch checklist

These need the product owner (accounts and real devices), so they are not automated.

- [ ] Cloudflare Pages project: build command `npm run build`, output directory `dist`; Pages reads the Node version from `.nvmrc`. Set `PUBLIC_PLAUSIBLE_DOMAIN` in the Pages environment if you want analytics. Set `SITE_URL` in the Pages environment to the production origin (for example `https://example.com`, no trailing slash); the build fails on Cloudflare Pages without it. It feeds `site` in `astro.config.mjs`, the canonical links, the sitemap and `robots.txt` (generated by `src/pages/robots.txt.ts`). Locally it defaults to `https://web-tools.pages.dev`.
- [ ] Lighthouse (mobile) on every tool page of the deployed URL: performance 95 or higher, LCP under 1.5 s.
- [ ] Real devices: iPhone Safari with a 48 MP photo, and picking HEIC from Photos keeps it HEIC (the browser must not transcode to JPG before the page sees it); a mid-range Android phone on Chrome with a 12-photo batch. Record the results and tune `MAX_MEGAPIXELS` in `src/engine/types.ts` if the iPhone fails.
- [ ] Google Search Console: add the property and submit `/sitemap-index.xml`.
- [ ] Confirm Plausible receives a test event after a real conversion.
- [ ] Model hosting: create the R2 bucket, upload the model files and set `PUBLIC_MODEL_BASE_URL` as described in "AI tools and model hosting". The tesseract.js language data is not uploaded: it ships with the site from `public/models/tessdata/`.
- [ ] Run `npm run test:models` with the production `PUBLIC_MODEL_BASE_URL` and look at the PNGs in `review/model-quality/`.
- [ ] Real devices for the round 3 tools: an iPhone and a mid-range Android phone running Remove background, Upscale image and Transcribe audio on a real file (memory limits and the WebGPU path), and Compress video and Video to GIF in Safari and Chrome.
- [ ] Check `/licenses/` lists every shipped dependency and model with its licence (a unit test checks the list; read the page once).

## Known limits

- System font stack only; no web fonts are loaded.
- Light theme only; no dark mode.
- 16-bit PNGs are converted to 8 bits per channel.
- Images over 50 MP are refused with an offer to resize to 24 MP first; the limit is a guess until it is tuned on real devices.
- Animated WebP converts the first frame only.
- The screenshot spec (`tests/e2e/screenshots.spec.ts`) runs on chromium only and writes to `review/` (gitignored). It is a design-review aid, not an assertion suite.
