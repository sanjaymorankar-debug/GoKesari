/**
 * Shop welcome kit (docs/shop-welcome-kit-2026-11, PR #431) — the checks that send e-mail, change
 * a shop or switch the admin flag: local tier (the local server, its database and mail catcher).
 *
 *   TC-WKIT-001 / 004  operations approve a shop → one welcome e-mail, sent, with both banners
 *   TC-WKIT-002 / SC-52  wizard registration + sandbox fee → live → e-mail → Marketing download → QR
 *   TC-WKIT-003        once per shop, ever (suspended and approved again)
 *   TC-WKIT-008        local language: Marathi (Maharashtra / Goa, PIN 40–44), Hindi elsewhere
 *   TC-WKIT-009        admin "Send welcome kit": off by default, admin only, once per shop, bulk by city
 *   TC-WKIT-032        26-Nov-2026: admin "Resend updated banner" (no second welcome, 10-minute guard)
 *   TC-WKIT-023        26-Nov-2026: the go-live e-mail is personalised (Dear <owner>, contact line, ASMY footer)
 */
import { readFileSync } from "node:fs";

import { as } from "../lib/actors";
import { db } from "../lib/db";
import { liveShop, mailMatching } from "../lib/go-live-helpers";
import { call, expectStatus, RUN } from "../lib/http";
import { expect, manual, qa } from "../lib/record";
import { approvedShopOfNewOwner, ctxFor, pageFor } from "../lib/sellers-helpers";
import { BASE_URL } from "../lib/target";
import { bannerFile, bannerQr, forgetKit, kitRows, kitSettled, withWelcomeKitFlag } from "../lib/welcome-kit-helpers";

const local = { tier: "local" as const, timeout: 300_000 };
const SUBJECT = /is now live on GoKesari/;

qa(["TC-WKIT-001", "TC-WKIT-004"], "Operations approve a shop: one welcome e-mail is queued and sent, with both banners and the print instructions", async () => {
  const since = Date.now();
  const { owner, shop } = await approvedShopOfNewOwner("wkit-approve");
  const rows = await kitSettled(shop.id);
  expect(rows, "one SHOP_WELCOME_KIT row for the shop").toHaveLength(1);
  expect(rows[0].user_id, "addressed to the owner").toBe(owner.id);
  // renderEmail adds the site's name to every subject ("… — Gokesari").
  expect(rows[0].subject, "subject").toMatch(new RegExp(`^Congratulations! ${String(shop.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is now live on GoKesari`));
  expect(rows[0].status, `sent (last error: ${rows[0].last_error ?? "none"})`).toBe("SENT");

  const mail = await mailMatching(owner.email, since, SUBJECT, 30_000);
  expect(mail, "the welcome e-mail in the owner's mailbox").toBeTruthy();
  const raw = mail!.text;
  for (const name of [`GoKesari-banner-en-${shop.slug}.pdf`, `GoKesari-banner-mr-${shop.slug}.pdf`]) expect(raw, `attachment ${name}`).toContain(name);
  for (const cid of ["gk-shop-banner-en", "gk-shop-banner-mr"]) expect(raw, `inline banner ${cid}`).toContain(`cid:${cid}`);
  for (const phrase of [
    "Welcome to GoKesari",
    "Print in COLOUR on a colour page",
    "not black and white",
    "landscape",
    "Fit to page",
    "sticker or flex",
    "scan the QR code with your phone",
    "eye level",
    "Laminate",
    "Scan this to order from our shop on GoKesari.",
    "रंगीत प्रिंट करा",
    "/shop/manage/products",
    "/shop/marketing",
    "/support",
  ]) {
    expect(raw, `the e-mail says "${phrase}"`).toContain(phrase);
  }
  return `"${shop.name}": 1 row SENT to ${rows[0].to_address}; e-mail has en + mr PDFs, both inline banners, every print instruction and the Marathi line`;
}, local);

qa(["TC-WKIT-002", "SC-52"], "Wizard registration + sandbox fee → live → welcome e-mail → Marketing download → QR opens the shop", async ({ browser }) => {
  const since = Date.now();
  const shop = await liveShop(browser, "wkit-wizard");
  const rows = await kitSettled(shop.shopId);
  expect(rows, "one welcome kit for the paid shop").toHaveLength(1);
  expect(rows[0].status, `sent (last error: ${rows[0].last_error ?? "none"})`).toBe("SENT");
  const [{ slug }] = await db()<{ slug: string }[]>`select slug from shops where id = ${shop.shopId}`;
  const mail = await mailMatching(shop.owner.email, since, SUBJECT, 30_000);
  expect(mail, "the welcome e-mail").toBeTruthy();
  expect(mail!.text).toContain(`GoKesari-banner-mr-${slug}.pdf`);

  const { context, page } = await pageFor(browser, shop.owner);
  try {
    await page.goto("/shop/marketing");
    const card = page.getByTestId("shop-banner");
    await expect(card).toBeVisible();
    const [file] = await Promise.all([page.waitForEvent("download"), card.getByRole("link", { name: "Marathi (PNG)" }).click()]);
    expect(file.suggestedFilename()).toBe(`GoKesari-banner-mr-${slug}.png`);
    const target = await bannerQr(readFileSync(await file.path()));
    expect(target, "the QR code on the banner").toBe(`${BASE_URL}/shops/${slug}`);
    await page.goto(new URL(target!).pathname);
    await expect(page.getByRole("heading", { name: shop.shopName }).first()).toBeVisible();
  } finally {
    await context.close();
  }
  return `"${shop.shopName}" paid in the sandbox → live → 1 e-mail SENT (en + mr) → Marathi PNG downloaded → QR /shops/${slug} shows the shop`;
}, { ...local, partial: "scanning the printed QR with a phone is TC-WKIT-010 (manual)" });

qa("TC-WKIT-003", "A shop is welcomed once, ever: suspended and approved again, no second e-mail", async () => {
  const { shop } = await approvedShopOfNewOwner("wkit-once");
  await kitSettled(shop.id);
  await db()`update shops set status = 'PENDING_APPROVAL' where id = ${shop.id}`;
  const again = await call(await as("ops"), "POST", `/api/shops/${shop.id}/approve`, { classification: "GREEN" });
  expectStatus(again, 200, "approve the shop again");
  const rows = await kitRows(shop.id);
  expect(rows, "still one welcome kit").toHaveLength(1);
  return `approved twice → ${rows.length} welcome kit row (${rows[0].status})`;
}, local);

qa("TC-WKIT-008", "Local language: Marathi for Maharashtra / Goa (PIN 40–44 without a state), Hindi elsewhere", async () => {
  const { owner, shop } = await approvedShopOfNewOwner("wkit-lang");
  const ctx = await ctxFor(owner);
  const seen: string[] = [];
  for (const [state, pincode, lang] of [
    ["Maharashtra", null, "mr"],
    ["Madhya Pradesh", null, "hi"],
    [null, "403001", "mr"],
    [null, "110001", "hi"],
    ["Goa", null, "mr"],
  ] as const) {
    await db()`update shops set state = ${state}, pincode = coalesce(${pincode}, pincode) where id = ${shop.id}`;
    const file = await bannerFile(ctx, shop.id, "?lang=local&format=png");
    expect(file.status, `banner for ${state ?? `PIN ${pincode}`}`).toBe(200);
    expect(file.filename, `language for ${state ?? `PIN ${pincode}`}`).toBe(`GoKesari-banner-${lang}-${shop.slug}.png`);
    seen.push(`${state ?? `no state, PIN ${pincode}`} → ${lang}`);
  }
  return seen.join("; ");
}, local);

qa("TC-WKIT-009", "Admin 'Send welcome kit': off by default, admin only, once per shop; bulk by city queues only the shops there without it", async () => {
  const city = `QA Welcome ${RUN}`;
  const a = await approvedShopOfNewOwner("wkit-old-a");
  const b = await approvedShopOfNewOwner("wkit-old-b");
  const elsewhere = await approvedShopOfNewOwner("wkit-old-c");
  for (const s of [a, b, elsewhere]) {
    await kitSettled(s.shop.id);
    await forgetKit(s.shop.id); // as for shops live before the welcome kit existed
  }
  await db()`update shops set city = ${city} where id in (${a.shop.id}, ${b.shop.id})`;
  const admin = await as("admin");
  const seen: string[] = [];

  const flags = await call(admin, "GET", "/api/admin/feature-flags");
  const flag = (flags.body.flags as { key: string; enabled: boolean }[]).find((f) => f.key === "shop_welcome_kit_admin_send_enabled");
  expect(flag?.enabled ?? false, "the flag is off by default on this server").toBe(false);
  const off = await call(admin, "POST", "/api/admin/shops/welcome-kit", { shopId: a.shop.id });
  expect(off.status, "flag off").toBe(404);
  expect(off.body?.error?.details?.reason).toBe("FEATURE_NOT_AVAILABLE");
  seen.push("flag off → 404 not available");

  await withWelcomeKitFlag(true, async () => {
    const ops = await call(await as("ops"), "POST", "/api/admin/shops/welcome-kit", { shopId: a.shop.id });
    expect(ops.status, "operator").toBe(403);
    const first = await call(admin, "POST", "/api/admin/shops/welcome-kit", { shopId: a.shop.id });
    expectStatus(first, 200, "admin sends to one shop");
    expect(first.body.result).toBe("QUEUED");
    const again = await call(admin, "POST", "/api/admin/shops/welcome-kit", { shopId: a.shop.id });
    expect(again.body.result, "a second send").toBe("ALREADY_SENT");
    const sentA = await kitSettled(a.shop.id);
    expect(sentA.map((r) => r.status)).toEqual(["SENT"]);
    seen.push("operator 403; admin QUEUED → SENT, again ALREADY_SENT");

    const preview = await call(admin, "GET", `/api/admin/shops/welcome-kit?city=${encodeURIComponent(city.toLowerCase())}&notWelcomed=1`);
    expectStatus(preview, 200, "preview the city");
    expect((preview.body.shops as { id: string }[]).map((s) => s.id), "only shop B is left in the city").toEqual([b.shop.id]);
    const bulk = await call(admin, "POST", "/api/admin/shops/welcome-kit", { bulk: { city } });
    expectStatus(bulk, 200, "bulk send for the city");
    expect(bulk.body).toEqual({ matched: 1, queued: 1, notQueued: 0, remaining: 0 });
    expect(await kitRows(b.shop.id), "shop B queued").toHaveLength(1);
    expect(await kitRows(elsewhere.shop.id), "the shop in another city is left alone").toHaveLength(0);
    seen.push(`bulk "${city}": preview 1, queued 1, other city untouched`);
  });
  return seen.join("; ");
}, local);

qa(["TC-WKIT-032", "TC-WKIT-023"], "Admin 'Resend updated banner': a shop that had the kit gets the current banners once, without a second welcome; a second press at once is refused", async () => {
  const s = await approvedShopOfNewOwner("wkit-resend");
  const kit = await kitSettled(s.shop.id);
  expect(kit.map((r) => r.status), "the go-live welcome kit").toEqual(["SENT"]);
  const [welcome] = await db()<{ body: string }[]>`select body from document_emails where doc_type = 'SHOP_WELCOME_KIT' and doc_id = ${s.shop.id}`;
  expect(welcome.body, "personalised opening").toMatch(/\n\nDear [^\n]+, congratulations! [^\n]+ is now live on GoKesari\.com/);
  expect(welcome.body).toContain("+91 91751 93009");
  expect(welcome.body).toContain("gokesari.com is a unit of ASMY GLOBAL TRADING & CONSULTANCY INDIA PRIVATE LIMITED");
  const admin = await as("admin");
  return withWelcomeKitFlag(true, async () => {
    const first = await call(admin, "POST", "/api/admin/shops/welcome-kit", { resendShopId: s.shop.id });
    expectStatus(first, 200, "resend updated banner");
    const again = await call(admin, "POST", "/api/admin/shops/welcome-kit", { resendShopId: s.shop.id });
    expect(again.status, "a second press at once").toBe(409);
    const until = Date.now() + 60_000;
    let row: { status: string; subject: string; body: string } | undefined;
    while (Date.now() < until) {
      [row] = await db()<{ status: string; subject: string; body: string }[]>`select status, subject, body from document_emails where doc_type = 'SHOP_BANNER_UPDATE' and doc_id = ${s.shop.id}`;
      if (row && !["PENDING", "SENDING"].includes(row.status)) break;
      await new Promise((r) => setTimeout(r, 1_500));
    }
    expect(row?.status, "the updated-banner e-mail").toBe("SENT");
    expect(row?.subject).toMatch(/updated GoKesari banners/);
    expect(row?.body).not.toMatch(/congratulations/);
    expect(await kitRows(s.shop.id), "the welcome kit itself is untouched").toHaveLength(1);
    return "welcome SENT and personalised; resend 200 → SENT (no congratulations); second press 409";
  });
}, local);

manual("TC-WKIT-010", "Scanning the printed QR with a phone opens the shop (browser, and the app when installed)", "needs a phone camera and the installed Android / iOS app; the app half also needs the real Apple Team ID and Android signing fingerprint on the server (docs/deep-links-activation.md)");
manual("TC-WKIT-011", "The PDF prints in colour on A4 landscape and stays readable and scannable", "needs a colour printer");
manual("TC-WKIT-012", "A native speaker approves the Marathi and Hindi wording", "needs a Marathi and a Hindi speaker (owner action; phrases listed in docs/shop-welcome-kit-2026-11/README.md)");
manual("TC-WKIT-013", "Production: the first real go-live e-mail is SENT", "read on gokesari.com's database after the next real shop goes live (no test payments on production)");
