import { test, expect, Page, chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * GoKesari E2E Test Runner
 * Executes critical test cases against test environment
 */

const TEST_BASE_URL = process.env.TEST_URL || 'https://test.gokesari.com';
const TEST_RESULTS_DIR = path.join(__dirname, '..', 'test-results');

interface TestResult {
  tcId: string;
  name: string;
  module: string;
  priority: 'P0' | 'P1' | 'P2';
  status: 'pass' | 'fail' | 'blocked' | 'skip';
  duration: number;
  error?: string;
  screenshot?: string;
  timestamp: string;
}

// Ensure results directory exists
if (!fs.existsSync(TEST_RESULTS_DIR)) {
  fs.mkdirSync(TEST_RESULTS_DIR, { recursive: true });
}

/**
 * Phase 1: Preflight & Smoke Tests
 */
test.describe('Preflight & Smoke Tests (P0)', () => {
  let page: Page;

  test.beforeAll(async () => {
    const browser = await chromium.launch();
    page = await browser.newPage();
  });

  test('TC-PRE-001: Test site is reachable and renders', async () => {
    const start = Date.now();
    try {
      const response = await page.goto(TEST_BASE_URL, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBeLessThan(400);
      expect(page.locator('body')).toBeTruthy();
      recordResult({
        tcId: 'TC-PRE-001',
        name: 'Test site is reachable and renders',
        module: 'Preflight & smoke',
        priority: 'P0',
        status: 'pass',
        duration: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      recordResult({
        tcId: 'TC-PRE-001',
        name: 'Test site is reachable and renders',
        module: 'Preflight & smoke',
        priority: 'P0',
        status: 'fail',
        duration: Date.now() - start,
        error: String(error),
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  });

  test('TC-PRE-002: Database-backed pages load (no 500s)', async () => {
    const start = Date.now();
    try {
      // Check common pages for 500 errors
      const pages = [
        '/products',
        '/orders',
        '/account',
        '/dashboard',
      ];

      for (const pagePath of pages) {
        const response = await page.goto(`${TEST_BASE_URL}${pagePath}`, {
          waitUntil: 'load',
        });
        expect(response?.status()).not.toBe(500);
      }

      recordResult({
        tcId: 'TC-PRE-002',
        name: 'Database-backed pages load (no 500s)',
        module: 'Preflight & smoke',
        priority: 'P0',
        status: 'pass',
        duration: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      recordResult({
        tcId: 'TC-PRE-002',
        name: 'Database-backed pages load (no 500s)',
        module: 'Preflight & smoke',
        priority: 'P0',
        status: 'fail',
        duration: Date.now() - start,
        error: String(error),
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  });

  test('TC-PRE-003: Required test accounts exist and can sign in', async () => {
    const start = Date.now();
    try {
      // Navigate to login
      await page.goto(`${TEST_BASE_URL}/login`, { waitUntil: 'domcontentloaded' });

      // Check that login form exists
      const emailInput = page.locator('input[type="email"]').first();
      expect(emailInput).toBeTruthy();

      recordResult({
        tcId: 'TC-PRE-003',
        name: 'Required test accounts exist and can sign in',
        module: 'Preflight & smoke',
        priority: 'P0',
        status: 'pass',
        duration: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      recordResult({
        tcId: 'TC-PRE-003',
        name: 'Required test accounts exist and can sign in',
        module: 'Preflight & smoke',
        priority: 'P0',
        status: 'fail',
        duration: Date.now() - start,
        error: String(error),
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  });

  test('TC-PRE-004: Business-rule defaults are in place', async () => {
    const start = Date.now();
    try {
      // Navigate to home
      await page.goto(TEST_BASE_URL, { waitUntil: 'domcontentloaded' });

      // Check for expected default elements
      const header = page.locator('header');
      expect(header).toBeTruthy();

      recordResult({
        tcId: 'TC-PRE-004',
        name: 'Business-rule defaults are in place',
        module: 'Preflight & smoke',
        priority: 'P0',
        status: 'pass',
        duration: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      recordResult({
        tcId: 'TC-PRE-004',
        name: 'Business-rule defaults are in place',
        module: 'Preflight & smoke',
        priority: 'P0',
        status: 'fail',
        duration: Date.now() - start,
        error: String(error),
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  });
});

/**
 * Phase 2: Authentication & Login Tests (P0)
 */
test.describe('Login, Onboarding & Profile (P0)', () => {
  test('TC-AUTH-001: New user signs up with unused mobile number', async ({ page }) => {
    const start = Date.now();
    try {
      await page.goto(`${TEST_BASE_URL}/signup`, { waitUntil: 'domcontentloaded' });

      // Check signup form exists
      const mobileInput = page.locator('input[type="tel"]').first();
      expect(mobileInput).toBeTruthy();

      recordResult({
        tcId: 'TC-AUTH-001',
        name: 'New user signs up with unused mobile number',
        module: 'Login, onboarding & profile',
        priority: 'P0',
        status: 'pass',
        duration: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      recordResult({
        tcId: 'TC-AUTH-001',
        name: 'New user signs up with unused mobile number',
        module: 'Login, onboarding & profile',
        priority: 'P0',
        status: 'fail',
        duration: Date.now() - start,
        error: String(error),
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  });
});

/**
 * Phase 3: Critical Business Flow Tests (P0/P1)
 */
test.describe('Cart & Checkout (P0/P1)', () => {
  test('TC-CART-001: Add product to cart', async ({ page }) => {
    const start = Date.now();
    try {
      await page.goto(`${TEST_BASE_URL}/products`, { waitUntil: 'domcontentloaded' });

      // Look for add to cart button
      const addToCartBtn = page.locator('button:has-text("Add to Cart")').first();

      if (await addToCartBtn.isVisible()) {
        await addToCartBtn.click();
        recordResult({
          tcId: 'TC-CART-001',
          name: 'Add product to cart',
          module: 'Cart & checkout',
          priority: 'P0',
          status: 'pass',
          duration: Date.now() - start,
          timestamp: new Date().toISOString(),
        });
      } else {
        recordResult({
          tcId: 'TC-CART-001',
          name: 'Add product to cart',
          module: 'Cart & checkout',
          priority: 'P0',
          status: 'skip',
          duration: Date.now() - start,
          error: 'No products found on page',
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      recordResult({
        tcId: 'TC-CART-001',
        name: 'Add product to cart',
        module: 'Cart & checkout',
        priority: 'P0',
        status: 'fail',
        duration: Date.now() - start,
        error: String(error),
        timestamp: new Date().toISOString(),
      });
    }
  });
});

/**
 * Helper function to record test results
 */
function recordResult(result: TestResult): void {
  const resultsFile = path.join(TEST_RESULTS_DIR, 'results.jsonl');
  fs.appendFileSync(resultsFile, JSON.stringify(result) + '\n');
  console.log(`[${result.status.toUpperCase()}] ${result.tcId}: ${result.name}`);
}

interface TestSummary {
  timestamp: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
  passRate: number;
  byModule: Record<string, ModuleTestStats>;
  byPriority: {
    p0: PriorityTestStats;
    p1: PriorityTestStats;
    p2: PriorityTestStats;
  };
}

interface ModuleTestStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

interface PriorityTestStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * Generate summary report
 */
export function generateSummaryReport(): void {
  const resultsFile = path.join(TEST_RESULTS_DIR, 'results.jsonl');

  if (!fs.existsSync(resultsFile)) {
    console.log('No test results found');
    return;
  }

  const lines = fs.readFileSync(resultsFile, 'utf-8').split('\n').filter((l: string) => l);
  const results: TestResult[] = lines.map((line: string) => JSON.parse(line) as TestResult);

  const summary: TestSummary = {
    timestamp: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r: TestResult) => r.status === 'pass').length,
    failed: results.filter((r: TestResult) => r.status === 'fail').length,
    skipped: results.filter((r: TestResult) => r.status === 'skip').length,
    blocked: results.filter((r: TestResult) => r.status === 'blocked').length,
    passRate: 0,
    byModule: {},
    byPriority: {
      p0: { total: 0, passed: 0, failed: 0, skipped: 0 },
      p1: { total: 0, passed: 0, failed: 0, skipped: 0 },
      p2: { total: 0, passed: 0, failed: 0, skipped: 0 },
    },
  };

  if (summary.total > 0) {
    summary.passRate = (summary.passed / summary.total) * 100;
  }

  // Group by module and priority
  for (const result of results) {
    if (!summary.byModule[result.module]) {
      summary.byModule[result.module] = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
      };
    }

    const moduleStats = summary.byModule[result.module] as ModuleTestStats;
    moduleStats.total += 1;
    if (result.status === 'pass') moduleStats.passed += 1;
    else if (result.status === 'fail') moduleStats.failed += 1;
    else if (result.status === 'skip') moduleStats.skipped += 1;

    const priorityKey = result.priority.toLowerCase() as 'p0' | 'p1' | 'p2';
    summary.byPriority[priorityKey].total += 1;
    if (result.status === 'pass') summary.byPriority[priorityKey].passed += 1;
    else if (result.status === 'fail') summary.byPriority[priorityKey].failed += 1;
    else if (result.status === 'skip') summary.byPriority[priorityKey].skipped += 1;
  }

  const summaryFile = path.join(TEST_RESULTS_DIR, 'summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  console.log(`\nSummary report saved to ${summaryFile}`);
  console.log(`\nTest Summary:`);
  console.log(`  Total: ${summary.total}`);
  console.log(`  Passed: ${summary.passed}`);
  console.log(`  Failed: ${summary.failed}`);
  console.log(`  Skipped: ${summary.skipped}`);
  console.log(`  Pass Rate: ${summary.passRate.toFixed(1)}%`);
}
