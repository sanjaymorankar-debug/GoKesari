/**
 * Shop documents before the registration fee, the 30-day promise, approval on promise and the
 * "Shops missing documents" list (owner decision 29 Oct 2026, docs/shop-documents-2026-10).
 *
 * Not in test-cases.xlsx yet (the plan dates from 3–4 Oct): the checks carry their own IDs,
 * SD-01 … SD-07, as in docs/shop-documents-2026-10/STAGING_TEST_RESULTS_2026-10-29.md.
 *
 * Signed tier: the staging shop-owner test account registers a QA shop through the long form's
 * endpoint (POST /api/shops) and verifies one document with the mock KYC vendor; the operator
 * only looks. The admin waives that QA shop's fee in SD-03w (the owner's fee-waiver flow for
 * test shops, 29 Oct 2026) and otherwise only looks. Nothing here approves, rejects or suspends
 * a shop, or changes a setting or a flag (QA agent rule 2): the "Confirm approval" click is left
 * to a person. SD-03 (a Cashfree sandbox payment) needs the "Sandbox payment" workflow; it and
 * SD-03w are alternatives for one shop — a waiver is refused once anything is paid.
 *
 * Runs in file order, one worker; the shop is handed on with stash() / unstash().
 */
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { pageAs } from "../lib/actors";
import { api, freshMobile } from "../lib/finance-helpers";
import { RUN, expectStatus, stash, unstash, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";

const signed = { tier: "signed" as const, timeout: 300_000 };
const SHOTS = join("docs", "shop-documents-2026-10", "staging-2026-10-29");
const REFERRAL = process.env.QA_REFERRAL_CODE ?? "E2ETEST1";

interface DocsShop {
  id: string;
  name: string;
  pan?: string;
  promisedBy?: string;
}

async function shot(page: Page, file: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, file), fullPage: true });
  return join(SHOTS, file);
}

/** The scenario digits of a mock-vendor PAN (chars 6–9) — never 0000 / 9999 / 8888 / 7777 / 6666 / 5555. */
function qaPan(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const pick = (n: number) => A[n % A.length];
  const t = Date.now();
  let digits = 1000 + (t % 4000);
  if (/^(\d)\1{3}$/.test(String(digits))) digits += 1;
  return `QADP${pick(Math.floor(t / 7))}${digits}${pick(Math.floor(t / 13))}`;
}

/** "28 Nov 2026" in India time — how the pages print the promised date. */
function indiaDate(d: Date) {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** The "Stationery Store" shop category, read as the shop owner (the only account this file needs besides ops / admin). */
async function stationeryCategory(): Promise<string> {
  const res = await api("shop", "GET", "/api/shop-categories");
  expectStatus(res, 200, "GET /api/shop-categories");
  return need(((res.body?.categories ?? []) as { id: string; name: string }[]).find((c) => c.name === "Stationery Store"), 'shop category "Stationery Store"').id;
}

function theShop(): DocsShop {
  return need(unstash<DocsShop>("sd-shop"), "the QA documents shop registered by SD-01 (run the file from the start)");
}

async function noHorizontalScroll(page: Page) {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
}

/* ------------------------------------------------------------------ SD-01 */

qa("SD-01", "no verified document: fee page shows 'Documents first' and no Pay button; the fee API and the promise answer 409 NO_VERIFIED_DOCUMENT", async ({ browser }) => {
  let shop = unstash<DocsShop>("sd-shop");
  if (!shop) {
    const name = `QA Docs 2026-10-29 ${RUN}`;
    const body = {
      name,
      ownerName: "QA Docs Owner",
      phone: freshMobile(),
      email: null,
      addressLine1: "QA Docs Lane, Paud Road",
      // The mock KYC vendor's records carry PIN 411001 (Shivajinagar): another PIN lowers the
      // cross-document consistency score and a found PAN goes to MANUAL_REVIEW instead of VERIFIED.
      area: "Shivajinagar",
      city: "Pune",
      state: "Maharashtra",
      pincode: "411001",
      latitude: "18.5308",
      longitude: "73.8475",
      shopType: "STATIONERY_STORE",
      categoryIds: [await stationeryCategory()],
      // A Maharashtra Shop Act the mock vendor cannot check (not …2222): it never becomes VERIFIED.
      shopActNumber: `MH-PUNE-QADOCS-${RUN.toUpperCase()}-41`,
      annualTurnoverRupees: 500_000,
      referralCode: REFERRAL,
      deliveryAvailable: false,
      openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "09:00", close: "21:00" })),
    };
    const reg = await api("shop", "POST", "/api/shops", body);
    expectStatus(reg, 201, "register the QA shop (long form's POST /api/shops)");
    shop = stash<DocsShop>("sd-shop", { id: reg.body.id as string, name: reg.body.name as string });
    expect(reg.body.status, "a new registration waits").toBe("PENDING_APPROVAL");
  }
  const view = await api("shop", "GET", `/api/shops/${shop.id}/verifications`);
  expectStatus(view, 200, "the shop's verification summary");
  const verified = (view.body.documents as { docType: string; status: string }[]).filter((d) => d.status === "VERIFIED");
  if (verified.length > 0) blocked(`the QA shop already has a verified document (${verified.map((d) => d.docType).join(", ")}); SD-01 needs a fresh shop`);

  const fee = await api("shop", "POST", `/api/shops/${shop.id}/registration-fee`);
  expect(fee.status, `fee API: ${why(fee)}`).toBe(409);
  expect(fee.body?.error?.details?.reason, "fee refusal reason").toBe("NO_VERIFIED_DOCUMENT");
  const promise = await api("shop", "POST", `/api/shops/${shop.id}/documents-promise`, { promise: true });
  expect(promise.status, `promise API: ${why(promise)}`).toBe(409);
  expect(promise.body?.error?.details?.reason, "promise refusal reason").toBe("NO_VERIFIED_DOCUMENT");

  const shots: string[] = [];
  for (const [label, viewport] of [["1280", { width: 1280, height: 900 }], ["390", { width: 390, height: 844 }]] as const) {
    const { context, page } = await pageAs(browser, "shop", { viewport });
    try {
      await page.goto(`/shop/registration-fee?shop=${shop.id}`);
      const block = page.getByTestId("documents-before-fee");
      await expect(block).toBeVisible();
      await expect(block.getByText("Documents first")).toBeVisible();
      await expect(block.getByText(/Get at least one of your documents verified/)).toBeVisible();
      await expect(page.getByRole("link", { name: "Verify my documents" })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Pay ₹/ })).toHaveCount(0);
      await expect(page.getByTestId("documents-promise"), "no promise box before a verified document").toHaveCount(0);
      shots.push(await shot(page, `sd01-fee-page-no-verified-${label}.png`));
    } finally {
      await context.close();
    }
  }
  return `shop "${shop.name}" (${shop.id}) PENDING_APPROVAL; fee API 409 ${fee.body.error.details.reason} "${fee.body.error.message}"; promise API 409 ${promise.body.error.details.reason}; page: Documents first, no Pay button, no promise box (${shots.join(", ")})`;
}, signed);

/* ------------------------------------------------------------------ SD-02 */

qa("SD-02", "PAN verified on the verification page → fee page lists the rest; 'Continue to payment' disabled until ticked; after the promise: 'Documents promised by <+30 days>' and the Pay button; fee API no longer refused", async ({ browser }) => {
  const shop = theShop();
  const shots: string[] = [];
  // 1. The owner verifies the PAN on /shop/verification (mock vendor: anything but the scenario digits verifies).
  const before = await api("shop", "GET", `/api/shops/${shop.id}/verifications`);
  expectStatus(before, 200, "verification summary");
  const panRow = (before.body.documents as { docType: string; status: string }[]).find((d) => d.docType === "PAN");
  if (panRow?.status !== "VERIFIED") {
    const pan = shop.pan ?? qaPan();
    stash<DocsShop>("sd-shop", { ...shop, pan });
    const { context, page } = await pageAs(browser, "shop", { viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(`/shop/verification?shop=${shop.id}`);
      const card = page.getByTestId("verification-PAN");
      await expect(card).toBeVisible();
      const again = card.getByRole("button", { name: /Submit again|Replace/ });
      if (await again.count()) await again.click();
      // Typed key by key: a value filled before React hydrates is lost and Verify stays disabled.
      const input = card.getByPlaceholder("ABCDE1234F");
      const verify = card.getByRole("button", { name: "Verify" });
      for (let attempt = 0; attempt < 3; attempt++) {
        await input.fill("");
        await input.pressSequentially(pan, { delay: 30 });
        const consent = card.getByRole("checkbox");
        if (!(await consent.isChecked())) await consent.check();
        if (await verify.isEnabled()) break;
        await page.waitForTimeout(2000);
      }
      await expect(verify).toBeEnabled();
      await verify.click();
      await expect(card.getByText("Verified", { exact: true })).toBeVisible({ timeout: 60_000 });
      shots.push(await shot(page, "sd02-verification-pan-verified-1280.png"));
    } finally {
      await context.close();
    }
  }
  const after = await api("shop", "GET", `/api/shops/${shop.id}/verifications`);
  const docs = after.body.documents as { docType: string; status: string }[];
  expect(docs.find((d) => d.docType === "PAN")?.status, "PAN after the check").toBe("VERIFIED");

  // 2. Fee API before the promise: refused for the other documents.
  const early = await api("shop", "POST", `/api/shops/${shop.id}/registration-fee`);
  const shopNow = await api("shop", "GET", `/api/shops/${shop.id}`);
  const alreadyPromised = Boolean(shopNow.body?.documentsPromisedAt);
  if (!alreadyPromised) {
    expect(early.status, `fee API after PAN only: ${why(early)}`).toBe(409);
    expect(early.body?.error?.details?.reason).toBe("DOCUMENTS_MISSING");
  }

  // 3. The fee page at 390 px: the remaining documents, the promise box, the tick, the promise.
  const { context, page } = await pageAs(browser, "shop", { viewport: { width: 390, height: 844 } });
  let promisedLabel = "";
  try {
    await page.goto(`/shop/registration-fee?shop=${shop.id}`);
    if (!alreadyPromised) {
      const block = page.getByTestId("documents-before-fee");
      await expect(block.getByText(/Not verified yet: .*GST number \(GSTIN\).*Shop Act/)).toBeVisible();
      await expect(block.getByText("Verified: PAN")).toBeVisible();
      await expect(page.getByRole("button", { name: /^Pay ₹/ })).toHaveCount(0);
      const box = page.getByTestId("documents-promise");
      await expect(box).toBeVisible();
      await expect(box.getByText(/I will provide all relevant documents within 30 days/)).toBeVisible();
      const go = box.getByRole("button", { name: "Continue to payment" });
      await expect(go, "disabled until ticked").toBeDisabled();
      shots.push(await shot(page, "sd02-fee-page-promise-unticked-390.png"));
      await box.getByRole("checkbox").check();
      await expect(go, "enabled once ticked").toBeEnabled();
      shots.push(await shot(page, "sd02-fee-page-promise-ticked-390.png"));
      await go.click();
    }
    const due = indiaDate(new Date(Date.now() + 30 * 86_400_000));
    const alert = page.getByText(/^Documents promised by /);
    await expect(alert).toBeVisible({ timeout: 60_000 });
    promisedLabel = (await alert.innerText()).trim();
    expect(promisedLabel, "the due date is today + 30 days").toBe(`Documents promised by ${due}`);
    await expect(page.getByText(/Still to provide: .*GST number \(GSTIN\).*Shop Act/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Pay ₹/ })).toBeVisible();
    await expect(page.getByTestId("documents-before-fee")).toHaveCount(0);
    const scroll = await noHorizontalScroll(page);
    expect(scroll.scrollWidth, "no horizontal scroll at 390 px").toBeLessThanOrEqual(scroll.clientWidth);
    shots.push(await shot(page, "sd02-fee-page-after-promise-390.png"));
  } finally {
    await context.close();
  }

  // 4. A second promise keeps the first date; the fee API now opens a checkout.
  const first = await api("shop", "GET", `/api/shops/${shop.id}`);
  const again = await api("shop", "POST", `/api/shops/${shop.id}/documents-promise`, { promise: true });
  expectStatus(again, 200, "a second promise");
  expect(again.body.dueAt, "a second tick keeps the first date").toBe(first.body.documentsDueAt ?? again.body.dueAt);
  const fee = await api("shop", "POST", `/api/shops/${shop.id}/registration-fee`);
  expectStatus(fee, 201, "fee checkout after the promise");
  stash<DocsShop>("sd-shop", { ...theShop(), promisedBy: promisedLabel.replace("Documents promised by ", "") });
  stash("sd-intent", { intentId: fee.body.intentId, redirectUrl: fee.body.redirectUrl, amountPaise: fee.body.amountPaise });
  return `PAN VERIFIED via the page; before the promise fee API 409 ${alreadyPromised ? "(already promised on an earlier run)" : early.body.error.details.reason}; page listed GSTIN + Shop Act, button disabled → enabled on tick; "${promisedLabel}", Pay button shown, no scroll at 390; second promise 200 keeps dueAt ${again.body.dueAt}; fee API 201 intent ${fee.body.intentId} ₹${fee.body.amountPaise / 100} → ${fee.body.redirectUrl} (${shots.join(", ")})`;
}, signed);

/* ----------------------------------------------------------------- SD-02a */

qa("SD-02a", "a PAN found but held for the team's check (MANUAL_REVIEW) is not 'verified': fee and promise still 409 NO_VERIFIED_DOCUMENT, page still 'Documents first'", async ({ browser }) => {
  const shop = need(unstash<DocsShop>("sd-shop-review"), "a QA shop whose PAN is in MANUAL_REVIEW");
  const view = await api("shop", "GET", `/api/shops/${shop.id}/verifications`);
  expectStatus(view, 200, "verification summary");
  const pan = (view.body.documents as { docType: string; status: string; lastErrorCode: string | null }[]).find((d) => d.docType === "PAN");
  if (pan?.status !== "MANUAL_REVIEW") blocked(`the PAN of "${shop.name}" is ${pan?.status ?? "missing"}, not MANUAL_REVIEW`);
  const fee = await api("shop", "POST", `/api/shops/${shop.id}/registration-fee`);
  expect(fee.status, why(fee)).toBe(409);
  expect(fee.body.error.details.reason).toBe("NO_VERIFIED_DOCUMENT");
  const promise = await api("shop", "POST", `/api/shops/${shop.id}/documents-promise`, { promise: true });
  expect(promise.status, why(promise)).toBe(409);
  expect(promise.body.error.details.reason).toBe("NO_VERIFIED_DOCUMENT");
  const { context, page } = await pageAs(browser, "shop", { viewport: { width: 390, height: 844 } });
  const shots: string[] = [];
  try {
    await page.goto(`/shop/verification?shop=${shop.id}`);
    await expect(page.getByTestId("verification-PAN")).toBeVisible();
    shots.push(await shot(page, "sd02a-verification-pan-in-review-390.png"));
    await page.goto(`/shop/registration-fee?shop=${shop.id}`);
    await expect(page.getByTestId("documents-before-fee").getByText("Documents first")).toBeVisible();
    await expect(page.getByTestId("documents-promise")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Pay ₹/ })).toHaveCount(0);
    shots.push(await shot(page, "sd02a-fee-page-pan-in-review-390.png"));
  } finally {
    await context.close();
  }
  return `"${shop.name}": PAN MANUAL_REVIEW (${pan.lastErrorCode}); fee 409 ${fee.body.error.details.reason} (missing ${fee.body.error.details.missing.join(", ")}); promise 409 ${promise.body.error.details.reason}; page Documents first, no promise box, no Pay (${shots.join(", ")})`;
}, signed);

/* ------------------------------------------------------------------ SD-03 */

qa("SD-03", "fee paid with the Cashfree sandbox: fee PAID, the shop stays PENDING_APPROVAL (a promised shop is never approved automatically)", async ({ browser }) => {
  const shop = theShop();
  const paid = unstash<{ runId: string; instrument: string }>("sd-paid");
  if (!paid) blocked("the sandbox payment has not been made (Sandbox payment workflow not dispatched)");
  const view = await api("shop", "GET", `/api/shops/${shop.id}`);
  expectStatus(view, 200, "the shop");
  expect(view.body.feePaymentStatus, "fee status after the sandbox payment").toBe("PAID");
  expect(view.body.status, "not approved automatically").toBe("PENDING_APPROVAL");
  const { context, page } = await pageAs(browser, "shop", { viewport: { width: 390, height: 844 } });
  let file = "";
  try {
    await page.goto(`/shop/registration-fee?shop=${shop.id}`);
    await expect(page.getByText("Payment received")).toBeVisible();
    await expect(page.getByText("Your registration is with our team for review.", { exact: false })).toBeVisible();
    file = await shot(page, "sd03-fee-paid-pending-390.png");
  } finally {
    await context.close();
  }
  return `sandbox run ${paid.runId} (${paid.instrument}); feePaymentStatus PAID, amountPaid ₹${(view.body.amountPaidPaise ?? 0) / 100}, status ${view.body.status}; page "Payment received", "with our team for review" (${file})`;
}, signed);

/* ----------------------------------------------------------------- SD-03w */

const WAIVE_REASON = "QA: shop documents test, fee waived (owner-approved)";

qa("SD-03w", "admin waives the fee from the approval queue (Waive fee → reason → Confirm waiver): the fee reads settled ('fee waived', ₹0), the shop stays PENDING_APPROVAL — a promised shop is never approved automatically", async ({ browser }) => {
  // The owner's fee-waiver flow for test shops (owner, 29 Oct 2026): Admin console → Shops,
  // "Waive fee" (shop-approval-panel.tsx) → POST /api/shops/{id}/waive-fee → waiveRegistrationFee.
  // Acts on the QA shop this file registered, and only while nothing has been paid.
  const shop = theShop();
  const before = await api("shop", "GET", `/api/shops/${shop.id}`);
  expectStatus(before, 200, "the shop before the waiver");
  if (before.body.status !== "PENDING_APPROVAL") blocked(`the QA shop is ${before.body.status}, not PENDING_APPROVAL`);
  const alreadyWaived = before.body.feePaymentStatus === "PAID" && (before.body.registrationFeePaise ?? 0) === 0;
  if (!alreadyWaived && before.body.amountPaidPaise !== 0) blocked(`the QA shop has paid ₹${before.body.amountPaidPaise / 100}; a waiver is refused once anything is paid`);

  const shots: string[] = [];
  const { context, page } = await pageAs(browser, "admin", { viewport: { width: 1280, height: 900 } });
  try {
    await page.goto("/admin/console/shops");
    const findCard = () =>
      page.getByText(shop.name, { exact: true }).first().locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' p-4 ')][1]");
    let card = findCard();
    await expect(card).toBeVisible();
    if (!alreadyWaived) {
      await expect(card.getByText(/^fee due · /)).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      shots.push(await shot(page, "sd03w-queue-fee-due-1280.png"));
      await card.getByRole("button", { name: "Waive fee" }).click();
      await expect(card.getByText(new RegExp(`Waive ${shop.name}.s registration fee of .*The fee becomes zero and reads as settled`))).toBeVisible();
      const reason = card.getByLabel("Reason for waiving the fee");
      const confirm = card.getByRole("button", { name: "Confirm waiver" });
      await expect(confirm, "disabled without a reason").toBeDisabled();
      await reason.pressSequentially(WAIVE_REASON, { delay: 10 });
      await expect(confirm, "enabled with a reason of 10+ characters").toBeEnabled();
      shots.push(await shot(page, "sd03w-queue-waive-reason-1280.png"));
      await confirm.click();
      await expect(page.getByText("Registration fee waived.")).toBeVisible({ timeout: 60_000 });
      shots.push(await shot(page, "sd03w-queue-waive-confirmed-1280.png"));
      await page.goto("/admin/console/shops");
      card = findCard();
    }
    await expect(card.getByText("fee waived", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Waive fee" }), "no Waive fee once settled").toHaveCount(0);
    await expect(card.getByTestId("approve-on-promise"), "still waits for a person").toBeVisible();
    await card.scrollIntoViewIfNeeded();
    shots.push(await shot(page, "sd03w-queue-fee-waived-1280.png"));
  } finally {
    await context.close();
  }

  // The settlement, and no automatic approval (the event layer runs after the waiver).
  await new Promise((r) => setTimeout(r, 5_000));
  const after = await api("shop", "GET", `/api/shops/${shop.id}`);
  expectStatus(after, 200, "the shop after the waiver");
  expect(after.body.registrationFeePaise, "fee snapshot after the waiver").toBe(0);
  expect(after.body.amountPaidPaise, "nothing paid").toBe(0);
  expect(after.body.feePaymentStatus, "the fee reads settled").toBe("PAID");
  expect(after.body.status, "a promised shop is not approved automatically").toBe("PENDING_APPROVAL");

  // The owner's fee page: nothing to pay, with the team for review.
  const owner = await pageAs(browser, "shop", { viewport: { width: 390, height: 844 } });
  let feeText = "";
  try {
    await owner.page.goto(`/shop/registration-fee?shop=${shop.id}`);
    await expect(owner.page.getByText("Nothing to pay", { exact: true })).toBeVisible();
    await expect(owner.page.getByText("Your registration is with our team for review.", { exact: false })).toBeVisible();
    await expect(owner.page.getByRole("button", { name: /^Pay ₹/ })).toHaveCount(0);
    feeText = (await owner.page.locator("dl").first().innerText()).replace(/\s+/g, " ").trim();
    shots.push(await shot(owner.page, "sd03w-fee-page-waived-390.png"));
  } finally {
    await owner.context.close();
  }
  return `${alreadyWaived ? "fee already waived on an earlier run" : `admin: queue "fee due" → Waive fee → reason "${WAIVE_REASON}" → Confirm waiver → "Registration fee waived."`}; queue badge "fee waived", no Waive fee, Approve on promise still shown; API registrationFee ₹0, paid ₹0, feePaymentStatus PAID, status ${after.body.status} after 5 s; owner fee page "Nothing to pay", "with our team for review", no Pay button; breakdown "${feeText}" (${shots.join(", ")})`;
}, signed);

/* ------------------------------------------------------------------ SD-04 */

qa("SD-04", "operator queue: the promised shop shows 'documents promised by <date>' and 'Approve on promise' with a confirm step; a shop without a promise has no such button", async ({ browser }) => {
  const shop = theShop();
  const { context, page } = await pageAs(browser, "ops", { viewport: { width: 1280, height: 900 } });
  const shots: string[] = [];
  try {
    await page.goto("/admin/console/shops");
    const name = page.getByText(shop.name, { exact: true }).first();
    await expect(name).toBeVisible();
    const card = name.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' p-4 ')][1]");
    const badge = card.getByText(/^documents promised by /);
    await expect(badge).toBeVisible();
    const badgeText = (await badge.innerText()).trim();
    if (shop.promisedBy) expect(badgeText).toBe(`documents promised by ${shop.promisedBy}`);
    const button = card.getByTestId("approve-on-promise");
    await expect(button).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    shots.push(await shot(page, "sd04-ops-queue-promise-badge-1280.png"));
    await button.click();
    const confirm = card.getByRole("button", { name: "Confirm approval" });
    await expect(confirm).toBeVisible();
    await expect(card.getByText(/promised to provide .* by .*Approve .* after inspecting it/)).toBeVisible();
    shots.push(await shot(page, "sd04-ops-queue-confirm-step-1280.png"));
    // Confirm approval is not clicked: QA agent rule 2 — nothing is approved on staging by the agent.

    // Every other pending shop without a promise: no Approve on promise.
    const others = await page.locator("div.p-4").filter({ has: page.getByRole("button", { name: "Reject" }) }).all();
    let withoutPromise = 0;
    for (const other of others) {
      if ((await other.getByText(/documents (promised by|overdue since)/).count()) > 0) continue;
      withoutPromise += 1;
      await expect(other.getByTestId("approve-on-promise"), "no Approve on promise without a promise").toHaveCount(0);
    }
    if (withoutPromise === 0) blocked("no pending shop without a promise in the operator's queue to compare with");
    return `ops queue: "${badgeText}", Approve on promise → confirm text shown with "Confirm approval" (not clicked: rule 2); ${withoutPromise} other pending shops without a promise show no Approve on promise (${shots.join(", ")})`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "the approval itself (Confirm approval → APPROVED) is not run by the QA agent on staging (rule 2)" });

/* ------------------------------------------------------------------ SD-05 */

qa("SD-05", "admin 'Shops missing documents': filters Live / Suspended / Awaiting approval; the QA shop with its missing documents, 'Reminders: 0 of 3' and the promised date; no horizontal scroll at 390 px", async ({ browser }) => {
  const shop = theShop();
  const status = (await api("shop", "GET", `/api/shops/${shop.id}`)).body.status as string;
  const view = status === "APPROVED" ? "live" : status === "SUSPENDED" ? "suspended" : "pending";
  const shots: string[] = [];
  const notes: string[] = [];
  for (const [label, viewport] of [["390", { width: 390, height: 844 }], ["1280", { width: 1280, height: 900 }]] as const) {
    const { context, page } = await pageAs(browser, "admin", { viewport });
    try {
      for (const v of ["live", "suspended", "pending"]) {
        await page.goto(`/admin/shops/missing-documents?view=${v}`);
        await expect(page.getByRole("heading", { name: "Shops missing documents" })).toBeVisible();
        const nav = page.getByRole("navigation", { name: "Filter" });
        for (const f of ["Live", "Suspended", "Awaiting approval"]) await expect(nav.getByRole("link", { name: f })).toBeVisible();
        const scroll = await noHorizontalScroll(page);
        expect(scroll.scrollWidth, `no horizontal scroll at ${label} px (${v})`).toBeLessThanOrEqual(scroll.clientWidth);
        if (label === "390") notes.push(`${v}: ${await page.getByText(/^\d+ shops?$/).first().innerText().catch(() => "empty")}`);
        if (v !== view) continue;
        const name = page.getByText(shop.name, { exact: true });
        await expect(name).toBeVisible();
        const card = name.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' p-4 ')][1]");
        await expect(card.getByText("GST number (GSTIN) missing")).toBeVisible();
        await expect(card.getByText(/Shop Act \(Shops & Establishments\) certificate (missing|waiting for our check)/)).toBeVisible();
        await expect(card.getByText(/Reminders:\s*0 of 3/)).toBeVisible();
        if (shop.promisedBy) await expect(card.getByText(`promised by ${shop.promisedBy}`)).toBeVisible();
        await card.scrollIntoViewIfNeeded();
        shots.push(await shot(page, `sd05-missing-documents-${v}-${label}.png`));
      }
    } finally {
      await context.close();
    }
  }
  return `QA shop (${status}) listed under view "${view}" with GSTIN + Shop Act, "Reminders: 0 of 3"${shop.promisedBy ? `, "promised by ${shop.promisedBy}"` : ""}; filters present; no horizontal scroll at 390 / 1280 on all three views; counts at 390 — ${notes.join("; ")} (${shots.join(", ")})`;
}, { ...signed, partial: "the shop is checked under 'Awaiting approval' unless it was approved — the Live view after approval needs the approval step (rule 2)" });

/* ------------------------------------------------------------------ SD-07 */

qa("SD-07", "shop owner's view: the dashboard shows the shop's state (live once approved, else 'Awaiting approval'); the verification page still lists GSTIN and Shop Act as 'Still needed'", async ({ browser }) => {
  const shop = theShop();
  const status = (await api("shop", "GET", `/api/shops/${shop.id}`)).body.status as string;
  const live = status === "APPROVED";
  const shots: string[] = [];
  const { context, page } = await pageAs(browser, "shop", { viewport: { width: 390, height: 844 } });
  try {
    // The dashboard works on the shop chosen in the switcher (cookie gk_shop), else the newest.
    await context.addCookies([{ name: "gk_shop", value: shop.id, url: "https://test.gokesari.com" }]);
    await page.goto("/shop");
    await expect(page.getByText(shop.name).filter({ visible: true }).first(), "the dashboard is on the QA shop").toBeVisible();
    let approvalText = "";
    if (live) {
      await expect(page.getByRole("status").filter({ hasText: "Awaiting approval" }), "no approval alert once live").toHaveCount(0);
      await expect(page.getByText("Pending approval", { exact: true })).toHaveCount(0);
    } else {
      const alert = page.getByRole("status").filter({ hasText: "Awaiting approval" });
      await expect(alert).toBeVisible();
      approvalText = (await alert.innerText()).replace(/\s+/g, " ").trim();
    }
    shots.push(await shot(page, `sd07-owner-dashboard-${live ? "live" : "pending"}-390.png`));
    await page.goto(`/shop/verification?shop=${shop.id}`);
    const needed = page.getByText("Still needed", { exact: true });
    await expect(needed).toBeVisible();
    const neededText = (await needed.locator("xpath=..").innerText()).replace(/\s+/g, " ").trim();
    expect(neededText).toMatch(/GST number \(GSTIN\)/);
    expect(neededText).toMatch(/Shop Act/);
    await expect(page.getByTestId("verification-PAN").getByText("Verified", { exact: true })).toBeVisible();
    await expect(page.getByTestId("verification-GSTIN").getByText("Not submitted", { exact: true })).toBeVisible();
    await expect(page.getByTestId("verification-SHOP_ACT").getByText("Not submitted", { exact: true })).toBeVisible();
    shots.push(await shot(page, `sd07-owner-verification-${live ? "live" : "pending"}-390.png`));
    return `shop ${status}: dashboard ${live ? "shows no approval alert (live)" : `shows "${approvalText}"`}; verification page "${neededText}", PAN Verified, GSTIN and Shop Act Not submitted (${shots.join(", ")})`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "the 'live' state needs the approval (SD-04 Confirm approval), which the QA agent does not run on staging without the owner's own go-ahead" });

/* ------------------------------------------------------------------ SD-06 */

/** The routes PR #274 gated (details, documents, location, submit). */
const WIZARD_ROUTES = ["details", "location", "documents", "submit"];
/** Wizard step 1 (GSTIN-first, or PAN with the no-GST declaration): not gated — D-106. */
const WIZARD_STEP1_ROUTES = ["gstin", "pan"];

qa("SD-06", "wizard gate with the flag off: a non-admin gets the long form at ?wizard=1 and 404 FEATURE_NOT_AVAILABLE from the wizard step routes; an admin gets the wizard", async ({ browser }) => {
  const shots: string[] = [];
  const answers: string[] = [];
  for (const step of WIZARD_ROUTES) {
    const res = await api("shop", "POST", `/api/shops/registration-draft/${step}`, {});
    expect(res.status, `POST registration-draft/${step}: ${why(res)}`).toBe(404);
    // featureNotAvailable(): code NOT_FOUND, details.reason FEATURE_NOT_AVAILABLE (services/feature-flags.ts).
    expect(res.body?.error?.details?.reason, `registration-draft/${step} reason`).toBe("FEATURE_NOT_AVAILABLE");
    expect(res.body?.error?.details?.feature, `registration-draft/${step} flag`).toBe("shop_onboarding_wizard_enabled");
    answers.push(`${step} ${res.status} ${res.body.error.code}/${res.body.error.details.reason}`);
  }
  {
    const { context, page } = await pageAs(browser, "shop", { viewport: { width: 390, height: 844 } });
    try {
      await page.goto("/shop/register?wizard=1");
      await expect(page.getByText("Tell us about your shop, clinic or office.", { exact: false })).toBeVisible();
      await expect(page.getByLabel(/Shop name/).first()).toBeVisible();
      await expect(page.getByText("A few quick steps", { exact: false })).toHaveCount(0);
      shots.push(await shot(page, "sd06-wizard-1-shop-owner-long-form-390.png"));
    } finally {
      await context.close();
    }
  }
  {
    const { context, page } = await pageAs(browser, "admin", { viewport: { width: 390, height: 844 } });
    try {
      await page.goto("/shop/register?wizard=1");
      await expect(page.getByText("A few quick steps", { exact: false })).toBeVisible();
      await expect(page.getByText("Tell us about your shop, clinic or office.", { exact: false })).toHaveCount(0);
      shots.push(await shot(page, "sd06-wizard-1-admin-wizard-390.png"));
    } finally {
      await context.close();
    }
  }
  return `shop owner: ?wizard=1 → long form; ${answers.join(", ")}; admin: ?wizard=1 → wizard ("A few quick steps"); the review step was not reached (would create an admin-owned draft/shop) (${shots.join(", ")})`;
}, { ...signed, partial: "the wizard's review step (review-documents, promise box, 'Create my shop and pay' disabled) was not reached on staging" });

qa("SD-06b", "wizard gate with the flag off: the wizard's step-1 routes (registration-draft/gstin, /pan) also answer a non-admin 404 FEATURE_NOT_AVAILABLE", async () => {
  // An empty body only: if the gate is missing the route stops at validation (422) and nothing is
  // saved or checked; a valid body would open a draft and run a KYC vendor check.
  const seen: string[] = [];
  const failures: string[] = [];
  for (const step of WIZARD_STEP1_ROUTES) {
    const res = await api("shop", "POST", `/api/shops/registration-draft/${step}`, {});
    seen.push(`${step} ${res.status} ${res.body?.error?.code ?? ""} "${res.body?.error?.message ?? ""}" ${JSON.stringify(res.body?.error?.details ?? {})}`);
    if (res.status !== 404 || res.body?.error?.details?.reason !== "FEATURE_NOT_AVAILABLE") failures.push(step);
  }
  expect(failures, `not gated by shop_onboarding_wizard_enabled: ${seen.join(" | ")}`).toEqual([]);
  return seen.join(" | ");
}, signed);
