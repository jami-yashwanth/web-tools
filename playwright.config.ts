import { defineConfig, devices } from '@playwright/test';

// A port of its own, and never reuse a running server: a stale `astro preview` would serve an old build.
const PORT = 4399;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: {
    command: `npm run build && npx astro preview --port ${PORT} --ignore-lock`,
    url: `http://localhost:${PORT}`,
    // The build carries the Plausible tag so the privacy test can watch it. Every test stubs plausible.io.
    // PUBLIC_AI_STUB swaps model inference for deterministic stand-ins; models are fetched from /test-models/ on this
    // server, which tests fulfil with page.route (no model files are ever put in dist).
    env: { PUBLIC_PLAUSIBLE_DOMAIN: 'tools.test', PUBLIC_AI_STUB: '1', PUBLIC_MODEL_BASE_URL: `http://localhost:${PORT}/test-models` },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
