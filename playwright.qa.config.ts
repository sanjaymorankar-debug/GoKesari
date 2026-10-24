import { defineConfig, devices } from "@playwright/test";

/**
 * The QA suite: the 791-case plan (test-cases.xlsx) automated as UI and API
 * checks, each one tagged with its TC ID. Separate from playwright.config.ts
 * so the older specs in tests/e2e keep their own settings.
 *
 *   E2E_BASE_URL=https://test.gokesari.com npx playwright test -c playwright.qa.config.ts
 *
 * Where it may run, and what runs there, is decided per case by its tier —
 * see tests/qa/README.md. Results: test-results/qa/<host>/*.jsonl, gathered
 * by scripts/qa/collect.ts into docs/testing/qa-runs/.
 */
const launchOptions = {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
};

const remote = /^https:/.test(process.env.E2E_BASE_URL ?? "");

export default defineConfig({
  testDir: "./tests/qa",
  // The test site is slow to answer (8–10 s for a cold page), so remote runs get more time.
  timeout: remote ? 180_000 : 90_000,
  expect: { timeout: remote ? 30_000 : 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/qa/playwright-report.json" }]],
  outputDir: "test-results/qa/artifacts",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    navigationTimeout: remote ? 90_000 : 45_000,
    actionTimeout: remote ? 30_000 : 15_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions } },
    // Cases marked { mobile: true } run here too (TC-UX-002: the same flows on a phone).
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions } },
  ],
});
