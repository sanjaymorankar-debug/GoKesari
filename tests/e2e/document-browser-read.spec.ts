/**
 * docs/document-upload-2026-10, "Reading in the browser" (defect D-18): the
 * shop owner's own browser reads a document photo — tesseract.js loaded from
 * /api/ocr-assets under the site's real CSP — and the fields come back
 * pre-filled with no server OCR involved. Desktop and phone (Pixel 7).
 *
 *   E2E_DATABASE_URL=… AUTH_SECRET=<server's> npx playwright test tests/e2e/document-browser-read.spec.ts
 *
 * The database must be seeded (kesari.dairy@example.com owns a dairy, a food
 * shop, so its checklist has the FSSAI card).
 */
import { expect, test } from "@playwright/test";
import sharp from "sharp";

import { encode } from "next-auth/jwt";
import postgres from "postgres";

const DB_URL = process.env.E2E_DATABASE_URL;
const AUTH_SECRET = process.env.AUTH_SECRET ?? "";
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SESSION_COOKIE = BASE_URL.startsWith("https") ? "__Secure-authjs.session-token" : "authjs.session-token";
const OWNER_EMAIL = process.env.E2E_SHOP_OWNER_EMAIL ?? "kesari.dairy@example.com";
const NEXT_YEAR = String(new Date().getFullYear() + 1);

test.skip(!DB_URL || !AUTH_SECRET, "E2E_DATABASE_URL and AUTH_SECRET (the server's) are required");
const sql = postgres(DB_URL ?? "postgres://invalid", { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function licencePhoto(): Promise<Buffer> {
  const line = (y: number, text: string) => `<text x="40" y="${y}" font-size="40" font-family="DejaVu Sans, Arial, sans-serif">${text}</text>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="600"><rect width="100%" height="100%" fill="white"/>` +
    line(80, "Food Safety and Standards Authority of India") +
    line(170, "License Number : 11521998000123") +
    line(260, "Name of Licensee : RAMESH KUMAR SHARMA") +
    line(350, `Valid Upto : 31/03/${NEXT_YEAR}`) +
    `</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

test("a document photo is read in the browser and the details come back pre-filled", async ({ browser }) => {
  test.setTimeout(150_000);
  const [owner] = await sql`select u.id, u.name, s.id as shop_id from users u join shops s on s.owner_id = u.id where u.email = ${OWNER_EMAIL} limit 1`;
  expect(owner, `seeded shop owner ${OWNER_EMAIL}`).toBeTruthy();
  await sql`update users set profile_completed_at = coalesce(profile_completed_at, now()), phone_verified_at = coalesce(phone_verified_at, now()) where id = ${owner.id}`;
  // A clean slate for this card, so the page offers the upload buttons.
  await sql`delete from seller_document_uploads where shop_id = ${owner.shop_id} and doc_type = 'FSSAI' and status = 'EXTRACTED'`;

  const context = await browser.newContext();
  const value = await encode({ token: { sub: owner.id, email: OWNER_EMAIL, name: owner.name }, secret: AUTH_SECRET, salt: SESSION_COOKIE });
  await context.addCookies([{ name: SESSION_COOKIE, value, url: BASE_URL }]);
  const page = await context.newPage();

  const cspViolations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) cspViolations.push(message.text());
  });
  const assets: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/ocr-assets/")) assets.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  await page.goto("/shop/documents");
  await expect(page.getByTestId("doc-upload-FSSAI")).toBeVisible();
  await page.getByTestId("doc-file-FSSAI").setInputFiles({ name: "fssai.jpg", mimeType: "image/jpeg", buffer: await licencePhoto() });

  const review = page.getByTestId("doc-review-FSSAI");
  await expect(review).toBeVisible({ timeout: 120_000 });
  await expect(review.getByTestId("doc-field-number")).toHaveValue("11521998000123");
  await expect(review.getByTestId("doc-field-valid-until")).toHaveValue(`${NEXT_YEAR}-03-31`);

  const [row] = await sql`select reader_engine, reader_confidence from seller_document_uploads
                          where shop_id = ${owner.shop_id} and doc_type = 'FSSAI' order by created_at desc limit 1`;
  expect(row.reader_engine).toBe("browser-tesseract");
  expect(Number(row.reader_confidence)).toBeGreaterThan(50);
  expect(assets.some((a) => a.startsWith("200 ") && a.endsWith("/worker.min.js"))).toBe(true);
  expect(assets.some((a) => a.startsWith("200 ") && a.includes("/core/"))).toBe(true);
  expect(assets.some((a) => a.startsWith("200 ") && a.endsWith("/lang/eng.traineddata.gz"))).toBe(true);
  expect(cspViolations).toEqual([]);

  // Leave nothing behind: the upload was never submitted.
  await review.getByTestId("doc-reupload-FSSAI").click();
  await context.close();
});

test("if the browser can't load the reader, the upload still goes through and the server reads it", async ({ browser }) => {
  test.setTimeout(150_000);
  const [owner] = await sql`select u.id, u.name, s.id as shop_id from users u join shops s on s.owner_id = u.id where u.email = ${OWNER_EMAIL} limit 1`;
  await sql`delete from seller_document_uploads where shop_id = ${owner.shop_id} and doc_type = 'FSSAI' and status = 'EXTRACTED'`;
  const context = await browser.newContext();
  const value = await encode({ token: { sub: owner.id, email: OWNER_EMAIL, name: owner.name }, secret: AUTH_SECRET, salt: SESSION_COOKIE });
  await context.addCookies([{ name: SESSION_COOKIE, value, url: BASE_URL }]);
  await context.route("**/api/ocr-assets/**", (route) => route.abort());
  const page = await context.newPage();

  await page.goto("/shop/documents");
  await page.getByTestId("doc-file-FSSAI").setInputFiles({ name: "fssai.jpg", mimeType: "image/jpeg", buffer: await licencePhoto() });
  const review = page.getByTestId("doc-review-FSSAI");
  await expect(review).toBeVisible({ timeout: 120_000 });

  const [row] = await sql`select reader_engine from seller_document_uploads
                          where shop_id = ${owner.shop_id} and doc_type = 'FSSAI' order by created_at desc limit 1`;
  // Locally the server's reader works (it reads the details); on a host where it doesn't, the card asks the owner to type them (NOT_READ).
  expect(row.reader_engine).toBe("tesseract");
  await review.getByTestId("doc-reupload-FSSAI").click();
  await context.close();
});
