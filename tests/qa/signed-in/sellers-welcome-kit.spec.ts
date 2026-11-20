/**
 * Shop welcome kit (docs/shop-welcome-kit-2026-11, PR #431) — the parts safe on test.gokesari.com:
 * the Seller Central → Marketing banner card and its downloads on a desktop and a phone, who may
 * download a shop's banner, the QR code on it, and who may use the admin "Send welcome kit" route.
 *
 * Signed tier. Nothing here sends a welcome e-mail — each shop gets it once, ever — and the admin
 * flag is only read: the sends run in the local tier (tests/qa/local/sellers-welcome-kit.spec.ts).
 */
import { readFileSync } from "node:fs";

import { as, pageAs } from "../lib/actors";
import { call } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { phonePage, sideways } from "../lib/regression-2026-11-helpers";
import { BASE_URL } from "../lib/target";
import { bannerFile, bannerQr } from "../lib/welcome-kit-helpers";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 300_000 };

/** Shop A (the "shop" account's active shop) with its slug as the server has it. */
async function shopA() {
  const a = need(world().shops.A, "shop A in the world");
  const id = need(a.id, "shop A's id in the world");
  const res = await call(await as("shop"), "GET", `/api/shops/${id}`);
  const slug = String(res.body?.slug ?? res.body?.shop?.slug ?? need(a.slug, "shop A's slug"));
  return { id, slug, name: a.name };
}

qa("TC-WKIT-005", "Seller Central → Marketing: the banner card downloads both banners as PDF and PNG, on a desktop and a phone", async ({ browser }) => {
  const shop = await shopA();
  const seen: string[] = [];
  const opens = [
    ["desktop 1280", () => pageAs(browser, "shop", { viewport: { width: 1280, height: 900 } })],
    ["phone (Pixel 7)", () => phonePage(browser, "shop")],
  ] as const;
  for (const [label, open] of opens) {
    const { context, page } = await open();
    try {
      await page.goto("/shop/marketing");
      const card = page.getByTestId("shop-banner");
      await expect(card, `${label}: the banner card`).toBeVisible();
      await expect(card.getByRole("heading", { name: "Your shop banner with QR code" })).toBeVisible();
      await expect(card).toContainText("Print it in colour");
      const enPdf = card.getByRole("link", { name: "English banner (PDF)" });
      const localPdf = card.getByRole("link", { name: /^(Marathi|Hindi) banner \(PDF\)$/ });
      const enPng = card.getByRole("link", { name: "English (PNG)" });
      const localPng = card.getByRole("link", { name: /^(Marathi|Hindi) \(PNG\)$/ });
      for (const link of [enPdf, localPdf, enPng, localPng]) await expect(link).toBeVisible();
      const language = (await localPdf.innerText()).startsWith("Marathi") ? "mr" : "hi";

      const [pdf] = await Promise.all([page.waitForEvent("download"), enPdf.click()]);
      expect(pdf.suggestedFilename(), `${label}: English PDF file name`).toBe(`GoKesari-banner-en-${shop.slug}.pdf`);
      expect(readFileSync(await pdf.path()).subarray(0, 5).toString(), "a PDF").toBe("%PDF-");
      const [png] = await Promise.all([page.waitForEvent("download"), localPng.click()]);
      expect(png.suggestedFilename(), `${label}: local PNG file name`).toBe(`GoKesari-banner-${language}-${shop.slug}.png`);
      expect(await bannerQr(readFileSync(await png.path())), `${label}: the QR on the downloaded banner`).toBe(`${BASE_URL}/shops/${shop.slug}`);
      if (label.startsWith("phone")) {
        expect(await sideways(page), "no sideways scroll on the phone").toBe(0);
        const box = await enPdf.boundingBox();
        expect(box?.height ?? 0, "buttons are at least 44 px tall on the phone").toBeGreaterThanOrEqual(43.5);
      }
      seen.push(`${label}: 4 buttons (English + ${language === "mr" ? "Marathi" : "Hindi"}), ${pdf.suggestedFilename()} + ${png.suggestedFilename()} downloaded, QR → /shops/${shop.slug}`);
    } finally {
      await context.close();
    }
  }
  return seen.join("; ");
}, signed);

qa(["TC-WKIT-006", "TC-WKIT-007"], "Banner download: the owner and operations get both languages (QR opens the shop page); another owner and a customer get 403", async () => {
  const shop = await shopA();
  const owner = await as("shop");
  const seen: string[] = [];
  for (const [query, type, lang] of [
    ["", "application/pdf", "en"],
    ["?lang=local", "application/pdf", null],
    ["?lang=en&format=png", "image/png", "en"],
    ["?lang=local&format=png", "image/png", null],
  ] as const) {
    const file = await bannerFile(owner, shop.id, query);
    expect(file.status, `owner GET banner${query}`).toBe(200);
    expect(file.type, `owner GET banner${query} type`).toContain(type);
    expect(file.filename ?? "", `owner GET banner${query} file name`).toMatch(new RegExp(`^GoKesari-banner-${lang ?? "(mr|hi)"}-${shop.slug}\\.${type === "image/png" ? "png" : "pdf"}$`));
    if (type === "image/png") expect(await bannerQr(file.body), `QR on banner${query}`).toBe(`${BASE_URL}/shops/${shop.slug}`);
    seen.push(`owner ${query || "(default)"} → 200 ${file.filename}`);
  }
  if (world().users.shopB) {
    const other = await bannerFile(await as("shopB"), shop.id);
    expect(other.status, "another shop's owner").toBe(403);
    seen.push(`shop B owner → ${other.status}`);
  }
  const customer = await bannerFile(await as("customer"), shop.id);
  expect(customer.status, "a customer").toBe(403);
  seen.push(`customer → ${customer.status}`);
  const ops = await bannerFile(await as("ops"), shop.id, "?lang=local");
  expect(ops.status, "operations").toBe(200);
  seen.push(`operator → ${ops.status}`);
  return seen.join("; ");
}, signed);

qa("TC-WKIT-009", "Admin → Send welcome kit: the route is ADMIN only and reports whether sending is switched on", async () => {
  const admin = await call(await as("admin"), "GET", "/api/admin/shops/welcome-kit?q=" + encodeURIComponent(world().shops.A?.name ?? ""));
  expect(admin.status, "admin GET").toBe(200);
  expect(typeof admin.body.enabled, "the flag state is reported").toBe("boolean");
  expect(Array.isArray(admin.body.shops), "live shops listed").toBe(true);
  const row = (admin.body.shops as { id: string; local: string; welcomeKit: unknown }[]).find((s) => s.id === world().shops.A?.id);
  const seen = [`admin → 200 (sending ${admin.body.enabled ? "on" : "off"}; ${admin.body.total} match${row ? `, shop A local ${row.local}` : ""})`];
  for (const role of ["ops", "shop", "customer"] as const) {
    const res = await call(await as(role), "GET", "/api/admin/shops/welcome-kit");
    expect(res.status, `${role} GET`).toBe(403);
    const post = await call(await as(role), "POST", "/api/admin/shops/welcome-kit", { shopId: need(world().shops.A?.id, "shop A's id") });
    expect(post.status, `${role} POST`).toBe(403);
    seen.push(`${role} → 403 / 403`);
  }
  return seen.join("; ");
}, { ...signed, partial: "sending itself (flag on, once per shop, bulk) runs in the local tier" });
