import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright smoke suite — see `e2e/`.
 *
 * The specs run against the PRODUCTION build served by `vite preview`, not the
 * dev server, because everything interesting here (the service worker, offline
 * reload, the SW update prompt) only exists in a real build. `vite preview`
 * serves under the app's base path `/mealspwa/` on port 4173, and the app uses
 * HashRouter, so screens are reached as `#/plan`, `#/capture`, etc. relative to
 * that base (see `baseURL` below).
 *
 * Chromium is preinstalled in the web environment under `/opt/pw-browsers/`
 * (PLAYWRIGHT_BROWSERS_PATH), and `@playwright/test` here is pinned to the
 * version whose bundled Chromium build matches it — so nothing is downloaded.
 *
 * Kept out of `src/` on purpose: Vitest's `include` only covers test files
 * under `src/`, and would otherwise try to run these browser specs.
 */
const BASE_URL = 'http://localhost:4173/mealspwa/';

export default defineConfig({
  testDir: './e2e',
  // The SW/offline specs mutate and observe a single shared build; serial and
  // single-worker keeps them from racing each other for the service worker.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    // Give SW registration a moment on slower CI hosts.
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      // `--no-sandbox` because the web/CI environment runs the browser as root,
      // where Chromium's sandbox refuses to start.
      use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--no-sandbox'] } },
    },
  ],
  // Build first so `dist/` exists and matches exactly what's served (the SW
  // update spec reads/writes `dist/sw.js`). `reuseExistingServer` skips this
  // when a preview server is already up locally.
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
