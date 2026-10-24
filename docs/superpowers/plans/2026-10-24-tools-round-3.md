# Tools Round 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 8 pages that run on the user's device: Remove background, Image to text, Upscale image, Transcribe audio, PDF to JPG, JPG to PDF, Compress video and Video to GIF.

**Architecture:** The registry gains the `ai` and `video` kinds and two new PDF ops. A shared model loader (streamed download with progress, Cache Storage, cancel) and capability detection feed per-tool Workers that use the same crash-safe client pattern as `src/pdf/client.ts`. The islands share one AI state machine (consent → download → work → done/error). All heavy code is dynamically imported, so pages stay ≤ 15 KB.

**Tech Stack:** onnxruntime-web, @huggingface/transformers, tesseract.js, pdfjs-dist, pdf-lib (existing), mp4box, mp4-muxer, gifenc; existing Vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-tools-round-3-design.md` (earlier specs still binding)

## Global Constraints

- Nothing the user provides leaves the device. The only allowed off-origin hosts are Plausible (events) and the model host (`PUBLIC_MODEL_BASE_URL`, GET only, no user data in URL or body).
- ≤ 15 KB JS (gzip) per tool page before interaction. Every engine, model and library is loaded via dynamic `import()` inside workers or on first interaction.
- Model files are never placed in `dist/` (25 MB Cloudflare Pages cap). Model URLs are `${PUBLIC_MODEL_BASE_URL}/<path>`. The default base is set in one place, `src/ai/config.ts`.
- Each model or library used must have a licence permitting commercial use, verified from its model card or LICENSE, and must be listed on `/licenses/` with a version-tagged source link. No RMBG-1.4, no @imgly/background-removal, no GPL ffmpeg.
- Spec §4 copy is binding and verbatim. Earlier tools' behaviour and copy are unchanged, except that the homepage gains the categories AI and Video.
- Visual system unchanged (tokens.css, one accent, system font plus monospace for code, 4/8 spacing, no shadows or gradients). Mobile ≤ 600 px rules as in round 2.
- Analytics: `convert_success {tool, count}` / `convert_error {tool, reason}`. Reasons are drawn from `network | cancelled | unsupported | too-large | too-long | corrupt | wrong-type | device | encrypted`. Props never carry content.
- E2E runs against a build with `PUBLIC_AI_STUB=1`. In that build, the bg, upscale and whisper workers return deterministic fake outputs without downloading models, and the model base URL points at the Playwright server's `/test-models/`. OCR uses real tesseract.js with the real `eng` fast model, served from `tests/fixtures/models/tessdata/` and committed if ≤ 5 MB. The production build must contain no stub code (asserted).
- All three Playwright engines must pass. Node ≥ 22.23.4.

## Review Focus

1. **Cancel mid-download, then start again:** a fresh download starts, and no half-written cache entry is ever used. Owned by Task 2.
2. **A cached model plus the network offline:** the tool still works offline, with no consent screen and no download state. Owned by Task 2.
3. **A HEIC or WebP image dropped on JPG to PDF:** converted through the image engine and embedded. Owned by Task 3.
4. **A portrait photo with EXIF orientation 6 on Remove background or Upscale:** the output keeps the upright orientation, reusing `applyOrientation`. Owned by Tasks 5 and 6.
5. **An audio file without speech, or with silence only:** "We couldn't hear any speech in this file." with no empty downloads offered. Owned by Task 7.

---

### Task 1: Registry, shell components, homepage categories

**Files:** Modify `src/tools.ts`, `src/layouts/ToolPage.astro`, `src/pages/index.astro`, `src/components/PdfTool.astro`. Create `src/components/AiTool.astro` and `src/components/VideoTool.astro`. Test: `tests/unit/tools.test.ts`, `tests/unit/build-output.test.ts`, `tests/e2e/home.spec.ts`.

**Interfaces — produces:**
```ts
export type Category = 'image'|'pdf'|'ai'|'video'|'developer'|'qr';
export type AiTool = ToolBase & { kind:'ai'; model:'bg'|'ocr'|'upscale'|'whisper'; accepts: string /* accept attr */ };
export type VideoTool = ToolBase & { kind:'video'; op:'compress'|'gif' };
// PdfTool.op becomes 'merge'|'split'|'to-images'|'from-images'
// ToolSlug adds: remove-background, image-to-text, upscale-image, transcribe-audio, pdf-to-jpg, jpg-to-pdf, compress-video, video-to-gif
// CATEGORY_LABEL adds ai:'AI', video:'Video'; homepage order: Image, PDF, AI, Video, Developer, QR code
```
Mounts:
- `<div data-kind="ai" data-tool data-model data-model-size>`
- `<div data-kind="video" data-tool data-op>`
- PdfTool handles `data-op="to-images"|"from-images"`

Each mount has a static empty state (drop zone, label + file input with the right `accept`, and the exact §4 privacy line), `[data-status]` (role=status, aria-live) and `[data-results]`. Use conditional spreads for boolean attributes.

- [ ] Step 1: Failing tests:
  - 17 slugs; kinds, models and ops as in spec §2; categories AI/Video
  - each tool has 3 how-to steps, 4–5 FAQs, title ≤ 60 chars, description 120–160 chars
  - build-output: each new page has its mount and exact §4 empty-state copy
  - homepage has 6 category headings in order
  - existing assertions still green
- [ ] Step 2: Run `npm test`. Expected FAIL.
- [ ] Step 3: Implement. Write real, honest copy (no promises beyond spec §3/§4: e.g. no "any language", no "unlimited"). FAQs must state the first-use model download size and that the model is cached. Related links stay within category plus one cross-link.
- [ ] Step 4: Run `npm test && npm run typecheck && npm run build && npm run check:budget && npx playwright test`. Expected PASS; earlier E2E unchanged.
- [ ] Step 5: Commit `feat: registry and shell for ai, video and pdf image tools`.

### Task 2: Shared AI infrastructure

**Files:** Create:
- `src/ai/config.ts`, `src/ai/loader.ts`, `src/ai/capability.ts`, `src/ai/errors.ts`
- `src/ai/client.ts` (generic sequential worker client), `src/ai/stub.ts` (stub outputs used only when `import.meta.env.PUBLIC_AI_STUB`)
- `src/ui/ai.ts` (shared AI island state machine)

Modify `playwright.config.ts` (webServer env `PUBLIC_AI_STUB=1`, `PUBLIC_MODEL_BASE_URL=http://localhost:4399/test-models`), `astro.config.mjs` if needed, and `tests/e2e/privacy.spec.ts` (allow the model host for GET only). Test: `tests/unit/ai-loader.test.ts`, `tests/unit/ai-capability.test.ts`, `tests/unit/ai-client.test.ts`, `tests/e2e/ai-shared.spec.ts`.

**Interfaces — produces:**
```ts
// config.ts
export const MODEL_BASE: string; // import.meta.env.PUBLIC_MODEL_BASE_URL ?? default
export const MODELS: Record<'bg'|'bgSmall'|'upscale'|'whisper'|'tessdata', { path: string; bytes: number; licence: string }>;
// errors.ts
export type AiFail = 'network'|'cancelled'|'unsupported'|'too-large'|'too-long'|'corrupt'|'wrong-type'|'device'|'encrypted';
export class AiError extends Error { reason: AiFail }
// loader.ts
export function isCached(url: string): Promise<boolean>;
export function loadModel(url: string, opts: { bytes: number; onProgress?(done: number, total: number): void; signal?: AbortSignal }): Promise<ArrayBuffer>;
// capability.ts
export interface Caps { webgpu: boolean; deviceMemoryGB?: number; mobile: boolean; cellular: boolean; webcodecs: { decode: boolean; h264Encode: boolean } }
export function detect(): Promise<Caps>;
// client.ts
export function createAiEngine<Req, Res>(workerFactory: () => Worker): { run(req: Req, transfer?: Transferable[], onProgress?: (p: { stage: 'download'|'work'; done: number; total: number }) => void): Promise<Res> } // rejects AiError
// ui/ai.ts
export interface AiToolDef<Res> { verb: string; modelKey?: keyof typeof MODELS; run(file: File, caps: Caps, onProgress): Promise<Res>; renderResult(res: Res, root: HTMLElement): void }
export function mountAi<Res>(el: HTMLElement, def: AiToolDef<Res>): { onSuccess(cb): void; onError(cb): void };
```

- [ ] Step 1: Failing unit tests (fake fetch with a ReadableStream body; an in-memory Cache API):
  - progress reaches total
  - a second load is served from the cache with no fetch
  - abort → `AiError('cancelled')`, nothing cached (Review Focus 1)
  - HTTP 404 → `unavailable` mapped to `network`
  - offline with a cache hit → succeeds (Review Focus 2)
  - capability mapping: navigator.gpu missing → webgpu false; `connection.type` cellular → cellular true; `VideoEncoder.isConfigSupported` false → h264Encode false
  - client: sequential runs, crash → `network` before the first message and `corrupt` after it, a fresh worker afterwards (mirror `src/pdf/client.ts`)
- [ ] Step 2: Failing E2E (`ai-shared.spec.ts`), using a throwaway test page or the remove-background page with the stub:
  - consent copy with the size
  - "You seem to be on mobile data." when `navigator.connection` is stubbed to cellular
  - Download and start → "Downloading the AI model… X of Y MB, one time only" with progress (use a slow-streaming route)
  - Cancel → back to consent
  - an aborted route → "Couldn't download the AI model. Check your connection." + Try again works
  - after one successful download, a reload skips consent
- [ ] Step 3: Implement. The consent screen appears only when the model is > 20 MB and not cached. Streaming download via `response.body.getReader()`; the cache write happens only after the full body arrives.
- [ ] Step 4: Run all gates. Expected PASS.
- [ ] Step 5: Commit `feat: shared on-device ai loader, capability and island`.

### Task 3: PDF to JPG and JPG to PDF

**Files:** Create `src/pdf/raster.ts` (pure sizing helpers), `src/pdf/raster-worker.ts`, `src/pdf/images-to-pdf.ts`, `src/ui/pdf-images.ts`. Modify `src/components/PdfTool.astro`, `scripts/make-fixtures.sh` (if fixtures are needed), `src/pages/licenses.astro` (pdf.js). Test: `tests/unit/pdf-raster.test.ts`, `tests/unit/images-to-pdf.test.ts`, `tests/e2e/pdf-images.spec.ts`.

**Interfaces — produces:**
```ts
export function renderScale(pageWidthPt: number, pageHeightPt: number, dpi: 150|300): { scale: number; dpi: 150|300; capped: boolean }; // ≤ 25 MP
export async function imagesToPdf(images: { bytes: Uint8Array; kind: 'jpg'|'png'; width: number; height: number }[], size: 'fit'|'a4'|'letter'): Promise<{ bytes: Uint8Array; pages: number }>;
```
- [ ] Step 1: Failing tests:
  - `renderScale(612,792,300)` → scale 300/72, not capped
  - a 5000×5000 pt page at 300 dpi → falls back to 150 or a smaller scale, `capped: true`, ≤ 25 MP
  - `imagesToPdf` with fit → page size equals the image size in pt (1 px = 0.75 pt); A4 → 595.28×841.89 with 36 pt margins and the image centred
  - E2E PDF to JPG:
    - three-pages.pdf → "3 pages" → Convert JPG standard → ZIP with `three-pages-page-1.jpg`…`-3.jpg` (JPEG magic)
    - PNG option gives PNG magic
    - a 1-page PDF gives a single Download
    - encrypted and damaged copy
  - E2E JPG to PDF:
    - photo.jpg + alpha.png + iphone-12mp.heic (Review Focus 3) → rows, reorder, Create PDF → `images.pdf` with 3 pages in the shown order (parse with pdf-lib)
    - A4 option gives A4 pages
- [ ] Step 2: Run them. FAIL.
- [ ] Step 3: Implement. pdfjs-dist runs in the raster worker with OffscreenCanvas (`disableWorker` inside our worker, or the legacy build). Its worker script is loaded through the dynamic chunk. JPG encoding: `OffscreenCanvas.convertToBlob({type:'image/jpeg', quality:0.85})` is acceptable here, because pages are ≤ 25 MP (state this in a code comment referencing the v1 canvas rule). Images to PDF: decode non-JPG/PNG through `src/engine/client.ts` (convert to PNG or JPG), then embed with pdf-lib.
- [ ] Step 4: All gates PASS.
- [ ] Step 5: Commit `feat: pdf to jpg and jpg to pdf`.

### Task 4: Image to text (OCR)

**Files:** Create `src/ai/ocr/worker.ts`, `src/ai/ocr/engine.ts`. Modify `src/components/AiTool.astro` (OCR result box), `src/pages/licenses.astro`. Add the fixture `tests/fixtures/ocr/hello.png` (rendered text "The quick brown fox 12345"), plus `tests/fixtures/models/tessdata/eng.traineddata.gz` (tessdata_fast, if ≤ 5 MB; otherwise route it to a downloaded copy in `make-fixtures.sh`). Test: `tests/unit/ocr.test.ts` (Node, real tesseract), `tests/e2e/ocr.spec.ts`.

**Interfaces:** `recognise(image: Blob, onProgress): Promise<{ text: string; confidence: number }>`, via `createAiEngine`.

- [ ] Step 1: Failing tests:
  - unit: recognising hello.png contains "quick brown fox" and "12345"
  - a blank image → empty text
  - E2E:
    - drop hello.png → "Reading text… n%" → text box contains the phrase; Copy; Download .txt `hello.txt`
    - a blank image → "We couldn't find any text in this image."
    - a low-confidence fixture (noisy, blurred) → the low-confidence note
    - wrong type (PDF) → wrong-type copy with "Try PDF to JPG →"
- [ ] Step 2: FAIL.
- [ ] Step 3: Implement with tesseract.js v5+ (`createWorker('eng', 1, { langPath: MODEL_BASE + '/tessdata', workerPath, corePath })`). Its worker and core files are served from `dist` via dynamic URL imports. Check the core wasm size; if any single file is > 25 MB, serve it from MODEL_BASE instead. OCR is small, so there's no consent screen. Apply EXIF orientation first by decoding through the image engine.
- [ ] Step 4: All gates PASS.
- [ ] Step 5: Commit `feat: image to text`.

### Task 5: Remove background

**Files:** Create `src/ai/bg/worker.ts`, `src/ai/bg/compose.ts` (pure), `src/ui/compare.ts` (before/after slider, keyboard operable). Modify `src/components/AiTool.astro`, `src/pages/licenses.astro`, `src/ai/config.ts` (verified model paths and licences). Test: `tests/unit/bg-compose.test.ts`, `tests/unit/compare.test.ts`, `tests/e2e/bg.spec.ts`.

**Interfaces:**
```ts
export function upsampleMask(mask: Float32Array, mw: number, mh: number, w: number, h: number): Uint8ClampedArray; // bilinear, 0–255
export function composeRGBA(px: Pixels, alpha: Uint8ClampedArray, bg: 'transparent' | { r:number; g:number; b:number }): Pixels;
```
- [ ] Step 1: Failing tests:
  - unit:
    - a 2×2 mask upsampled to 4×4 gives the expected bilinear values
    - compose with transparent keeps RGB and sets alpha
    - compose with white blends to white where alpha is 0
    - a rotated-6.heic-derived Pixels input keeps orientation (Review Focus 4: orientation applied before inference)
  - E2E (stub inference returns a centre-ellipse mask):
    - consent → download (stub model file from /test-models) → "Removing background… n%" → result with a checkerboard and slider (aria-label "Compare before and after", ArrowLeft/Right move it)
    - Download PNG `photo-no-bg.png` has PNG magic and an alpha channel (IHDR colour type 6), with transparent corners
    - White option gives opaque corners
    - a > 25 MP image shows "Large photo: processed at 25 MP."
- [ ] Step 2: FAIL.
- [ ] Step 3: Implement.
  - Model choice: U²-Net general (and u2netp) ONNX from an Apache-2.0 source. Verify the licence and record the URL and licence in `config.ts` and on `/licenses/`.
  - Preprocess: resize to 320×320, normalise.
  - Runtime: onnxruntime-web, preferring the `webgpu` execution provider and falling back to `wasm`.
  - Pick u2netp when `caps.mobile || deviceMemoryGB < 4`.
  - Output PNG via the existing encoder.
- [ ] Step 4: All gates PASS.
- [ ] Step 5: Commit `feat: remove background`.

### Task 6: Upscale image

**Files:** Create `src/ai/upscale/worker.ts`, `src/ai/upscale/tiles.ts` (pure). Modify AiTool, licences, config. Test: `tests/unit/upscale-tiles.test.ts`, `tests/e2e/upscale.spec.ts`.

**Interfaces:**
```ts
export function planTiles(w: number, h: number, tile: 128, overlap: 16): { x: number; y: number; w: number; h: number }[];
export function stitch(tiles: { rect; data: Uint8ClampedArray }[], w: number, h: number, scale: 2|4, overlap: number): Uint8ClampedArray; // feathered blend
```
- [ ] Step 1: Failing tests:
  - unit:
    - planTiles covers every pixel
    - stitching tiles from an identity "upscale" (nearest ×2 per tile) equals nearest ×2 of the whole image, with no seam differences within tolerance 1
  - E2E (stub = nearest-neighbour ×N):
    - 2× output dimensions are double; `<base>-2x.png`
    - 4× is hidden when WebGPU is absent (init-script deletes navigator.gpu) and shown when stubbed present
    - too large at 4× → "Upscaled image would be too large. Try 2×."
    - orientation-6 input comes out upright (Review Focus 4)
- [ ] Step 2: FAIL.
- [ ] Step 3: Implement with realesr-general-x4v3 ONNX (BSD-3, verify). Run at ×4; for 2× output, downscale the ×4 result with the existing box filter.
- [ ] Step 4: All gates PASS.
- [ ] Step 5: Commit `feat: upscale image`.

### Task 7: Transcribe audio

**Files:** Create `src/ai/whisper/worker.ts`, `src/ai/whisper/subtitles.ts` (pure), `src/ai/whisper/audio.ts` (decode + resample, main thread via OfflineAudioContext, then transfer Float32Array). Modify AiTool, licences, config. Test: `tests/unit/subtitles.test.ts`, `tests/unit/resample.test.ts`, `tests/e2e/whisper.spec.ts`. Fixtures: `tests/fixtures/audio/hello.wav` (2 s tone or speech-like), `tests/fixtures/audio/silence.wav`, `tests/fixtures/audio/long.wav` header claiming > 30 min (or a generated 31 min silent WAV at 8 kHz ≈ 30 MB; gitignored and made by make-fixtures).

**Interfaces:**
```ts
export interface Segment { start: number; end: number; text: string }
export function toSrt(segs: Segment[]): string; // "1\n00:00:00,000 --> 00:00:02,500\nHello\n\n"
export function toVtt(segs: Segment[]): string; // "WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nHello\n\n"
export function toTxt(segs: Segment[]): string;
```
- [ ] Step 1: Failing tests:
  - unit:
    - SRT and VTT exact format, including hours > 0 and millisecond rounding
    - toTxt joins segments with spaces and normalises whitespace
    - resample 44.1 kHz → 16 kHz keeps duration within 1 sample
  - E2E (stub returns fixed segments for any non-silent audio, empty for silence):
    - consent shows "80 MB"-class size from config
    - "Transcribing… n%" and live text
    - Copy; downloads `.txt`/`.srt`/`.vtt` with the right content
    - silence → "We couldn't hear any speech in this file." with no download buttons (Review Focus 5)
    - > 30 min → "Audio up to 30 minutes for now."
    - no WebGPU → the slow-device note
- [ ] Step 2: FAIL.
- [ ] Step 3: Implement with @huggingface/transformers `pipeline('automatic-speech-recognition', 'onnx-community/whisper-base' (verify MIT), { device: webgpu ? 'webgpu' : 'wasm', dtype: 'q8' })`, with `env.remoteHost`/`localModelPath` set to MODEL_BASE. Chunk length 30 s, return timestamps.
- [ ] Step 4: All gates PASS.
- [ ] Step 5: Commit `feat: transcribe audio`.

### Task 8: Compress video

**Files:** Create `src/video/demux.ts`, `src/video/limits.ts` (pure), `src/video/compress.ts`, `src/video/worker.ts`, `src/video/client.ts`, `src/ui/video.ts`. Modify VideoTool, licences, `scripts/make-fixtures.sh` (generate `tests/fixtures/video/clip.mp4` (3 s, H.264 + AAC, 640×360) and `clip.webm` with `ffmpeg` if installed via brew, a dev-only tool, never shipped). Test: `tests/unit/video-limits.test.ts`, `tests/e2e/video-compress.spec.ts`.

**Interfaces:**
```ts
export function checkLimits(meta: { durationS: number; bytes: number }): 'ok' | 'too-long' | 'too-large'; // 120 s, 200 MB
export function targetBitrate(preset: 'small'|'balanced'|'better', w: number, h: number): number;
export function compressVideo(file: File, opts: { preset; maxWidth: null|1080|720 }, onProgress): Promise<{ blob: Blob; inBytes: number; outBytes: number }>;
```
- [ ] Step 1: Failing tests:
  - unit:
    - limits at boundaries (120 s ok, 120.1 too-long; 200 MB ok, more too-large)
    - bitrate presets monotonic
  - E2E:
    - clip.mp4 → "Compressing… n%" → "<in> → <out>" and Download MP4 `clip-compressed.mp4` with `ftyp` in its first 12 bytes, a duration within 0.2 s of the input (parse with mp4box in the test), and width ≤ 720 when 720p is chosen
    - `VideoEncoder` deleted → "Your browser can't encode video. Try Chrome, Edge, Safari 17+ or Firefox 130+."
    - an over-limit metadata stub → limits copy
    - WebM handling per ruling (supported, or the unsupported copy)
  - If an engine lacks H.264 encoding in Playwright (e.g. Chromium builds without proprietary codecs), the test asserts the no-encode copy for that engine instead. Document per-engine outcomes in the report.
- [ ] Step 2: FAIL.
- [ ] Step 3: Implement: mp4box demux → VideoDecoder → VideoFrame scale (OffscreenCanvas per frame is acceptable at ≤ 1080p) → VideoEncoder (avc1.42001f / avc1.640028 chosen via isConfigSupported) → mp4-muxer. Copy AAC samples through. Backpressure on `encodeQueueSize`.
- [ ] Step 4: All gates PASS.
- [ ] Step 5: Commit `feat: compress video`.

### Task 9: Video to GIF

**Files:** Create `src/video/gif.ts`, `src/video/frames.ts` (pure sampling). Modify `src/ui/video.ts`, VideoTool. Test: `tests/unit/video-frames.test.ts`, `tests/e2e/video-gif.spec.ts`.

**Interfaces:**
```ts
export function sampleTimes(start: number, end: number, fps: 10|15): number[]; // ≤ 15 s span
export function makeGif(file: File, opts: { start: number; end: number; width: 320|480; fps: 10|15 }, onProgress): Promise<Blob>;
```
- [ ] Step 1: Failing tests:
  - unit:
    - sampleTimes(0,2,10) gives 20 times from 0 to 1.9
    - a span > 15 s gives a RangeError
  - E2E:
    - clip.mp4 with trim 0–2, width 320, 10 fps → "Making GIF… n%" → `clip.gif` starting `GIF89a`, logical width 320
    - span 0–20 → "GIFs can be up to 15 seconds."
    - the trim preview `<video>` is present
- [ ] Step 2: FAIL.
- [ ] Step 3: Implement with the decode path from Task 8 (decode only, no encoder needed, so GIF works even without H.264 encoding) plus gifenc.
- [ ] Step 4: All gates PASS.
- [ ] Step 5: Commit `feat: video to gif`.

### Task 10: Analytics, privacy, licences audit, model quality script

**Files:** Modify every new island (track calls), `tests/e2e/privacy.spec.ts`, `src/pages/licenses.astro` (final audit), `package.json` (`test:models`). Create `scripts/model-quality.mjs` (manual, not in CI). Test: `tests/e2e/privacy.spec.ts`, `tests/unit/build-output.test.ts`.

- [ ] Step 1: Failing tests:
  - for each new page, exactly one `convert_success {tool, count}` per finished job, and `convert_error {tool, reason}` per failure (reason in the union)
  - privacy needles (file name, file head bytes, OCR text, transcript text) absent from every request; the model host receives GET only
  - build-output: every library and model in `MODELS` and package deps appears on `/licenses/`
  - the production build (no `PUBLIC_AI_STUB`) contains no stub code (grep for the stub marker string in `dist`)
- [ ] Step 2: FAIL.
- [ ] Step 3: Implement. `model-quality.mjs` downloads the real models and runs the three manual quality checks from spec §5.3, printing pass/fail (documented in the README).
- [ ] Step 4: All gates PASS.
- [ ] Step 5: Commit `feat: analytics, privacy and licence coverage for round 3`.

### Task 11: Visual pass and screenshots

**Files:** `src/styles/tokens.css` (scoped rules), `tests/e2e/screenshots.spec.ts`.

- [ ] Step 1: Run `impeccable` critique against the approved system. Restyle new pages only.
- [ ] Step 2: Capture every §4 state of the 8 new pages + homepage at 390×844 and 1280×800. Use deterministic waits.
- [ ] Step 3: Look at every PNG, critique honestly, fix and re-capture.
- [ ] Step 4: All gates PASS. Commit `style: visual pass for round 3 tools`.
