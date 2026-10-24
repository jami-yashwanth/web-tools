// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { fileURLToPath } from 'node:url';

// onnxruntime-web's build that loads its .wasm from bytes or a URL we give it. Its package exports only the builds
// with the .wasm referenced next to the script, which the bundler would copy into dist a second time.
/** @param {string} file */
const ort = (file) => fileURLToPath(new URL(`./node_modules/onnxruntime-web/dist/${file}`, import.meta.url));
/** @param {string} path */
const local = (path) => fileURLToPath(new URL(path, import.meta.url));

// The canonical origin: used for canonical links, the sitemap and robots.txt. Production builds on Cloudflare Pages
// must say which domain they serve, or every canonical would point at the placeholder.
if (process.env.CF_PAGES && !process.env.SITE_URL) {
  throw new Error('Set SITE_URL in Cloudflare Pages env (for example https://example.com)');
}

export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL || 'https://web-tools.pages.dev',
  trailingSlash: 'always',
  integrations: [sitemap()],
  vite: {
    resolve: {
      alias: {
        'ort-wasm-runtime': ort('ort.wasm.min.mjs'),
        'ort-webgpu-runtime': ort('ort.webgpu.min.mjs'),
        // transformers.js (Transcribe audio) runs on whichever of the two the whisper worker picked, not its own copy
        // of onnxruntime (src/ai/whisper/ort-shim.ts), with the same onnxruntime-common as our runtime.
        'onnxruntime-web/webgpu': local('./src/ai/whisper/ort-shim.ts'),
        'onnxruntime-common': local('./node_modules/onnxruntime-common/dist/esm/index.js'),
      },
    },
    // The engine worker is a module worker. 'es' lets it code-split, so each codec stays its own
    // dynamically imported chunk; the default 'iife' inlines every codec (2+ MB) into the worker file.
    // Worker assets take the page build's names, so a file both import (onnxruntime's .wasm: the page checks whether
    // it is cached, the worker loads it) is one file at one URL.
    worker: { format: 'es', rollupOptions: { output: { assetFileNames: '_astro/[name].[hash][extname]' } } },
    // Always a string, so `import.meta.env.PUBLIC_AI_STUB === '1'` folds to a constant and a production build drops
    // the test-only AI stubs (src/ai/stub.ts) entirely. Set to 1 only by the Playwright build.
    define: { 'import.meta.env.PUBLIC_AI_STUB': JSON.stringify(process.env.PUBLIC_AI_STUB ?? '') },
  },
});
