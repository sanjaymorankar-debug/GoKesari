/**
 * After registration: approval and rejection with a classification, the
 * classification and GST / PAN rules, the registration fee schedule, fee
 * payments and the approval gate, referral codes, shop categories, operators
 * registering for an owner, the onboarding stages KYC_PENDING →
 * PAYMENT_PENDING → VERIFIED → ACTIVE, and what a shop that is not ACTIVE
 * may do.
 *
 * Local tier: it approves and rejects shops, changes the fee schedule (and
 * restores it) and arranges verified documents in the database. Every shop
 * here belongs to a fresh owner, never to the world's shops.
 */
import { anonymous, call, expectStatus, RUN, why } from "../lib/http";
import { as, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { expect, qa } from "../lib/record";
import { world } from "../lib/world";
import {
  approvedShopOfNewOwner,
  auditRows,
  ctxFor,
  freshAccount,
  gstinFor,
  markDocumentsVerified,
  needPanStorage,
  notificationsOf,
  pageFor,
  registerShop,
  registrationBody,
  shopCategoryId,
  shopRow,
  uniquePan,
  uniqueShopAct,
} from "../lib/sellers-helpers";

const local = { tier: "local" as const, timeout: 180_000 };

/** A pending shop of a fresh owner whose documents are verified and fee settled (stage VERIFIED). */
async function verifiedPendingShop(label: string, overrides: Record<string, unknown> = {}) {
  const owner = await freshAccount(label);
  const ctx = await ctxFor(owner);
  const { shop, body } = await registerShop(ctx, overrides);
  await markDocumentsVerified(shop.id);
  await db()`update shops set fee_payment_status = 'PAID' where id = ${shop.id} and fee_payment_status <> 'PAID'`;
  return { owner, ctx, shop, body };
}

async function guestFinds(name: string) {
  const guest = await anonymous();
  const res = await call(guest, "GET", `/api/shops?q=${encodeURIComponent(name)}&limit=24`);
  await guest.dispose();
  const list = (Array.isArray(res.body) ? res.body : (res.body?.shops ?? [])) as { name: string }[];
  return list.some((s) => s.name === name);
}

/* --------------------------------------------------- approve / reject */

qa("TC-ONB-012", "the operator approves a shop as KESARI on the Shop approvals screen (and another as GREEN): APPROVED, classification kept with history, owner notified, shop on the storefront", async ({ browser }) => {
  const since = new Date();
  const a = await verifiedPendingShop("onb012a");
  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto("/admin/console/shops");
    const card = page.locator("#shop-approvals div.p-4").filter({ hasText: a.shop.name }).first();
    await expect(card).toBeVisible();
    await card.getByLabel("Classify as").selectOption("KESARI");
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(page.locator("#approved-shops")).toContainText(a.shop.name, { timeout: 20_000 });
  } finally {
    await context.close();
  }
  const b = await verifiedPendingShop("onb012b");
  expectStatus(await call(await as("ops"), "POST", `/api/shops/${b.shop.id}/approve`, { classification: "GREEN" }), 200, "approve as GREEN");
  const out: string[] = [];
  for (const [s, cls] of [[a, "KESARI"], [b, "GREEN"]] as const) {
    const row = await shopRow(s.shop.id);
    expect(row.status).toBe("APPROVED");
    expect(row.lifecycle_status).toBe("ACTIVE");
    expect(row.classification).toBe(cls);
    const history = await call(await as("ops"), "GET", `/api/shops/${s.shop.id}/classification`);
    expectStatus(history, 200, "classification history");
    expect(JSON.stringify(history.body)).toContain(cls);
    const notes = await notificationsOf(s.owner.id, since);
    expect(notes.map((n) => n.type), "owner notified").toContain("shop.approved");
    expect(await guestFinds(s.shop.name), `${s.shop.name} is on the storefront`).toBe(true);
    out.push(`${s.shop.name} → APPROVED ${cls}, history row, owner notified, listed`);
  }
  return out.join("; ");
}, { ...local, mobile: false });

qa("TC-ONB-013", "the operator rejects a shop with a reason: REJECTED, owner notified with the reason, never public", async () => {
  const since = new Date();
  const { owner, shop } = await verifiedPendingShop("onb013");
  const res = await call(await as("ops"), "POST", `/api/shops/${shop.id}/reject`, { reason: "QA: Shop Act copy is unreadable" });
  expectStatus(res, 200, "reject");
  const row = await shopRow(shop.id);
  expect(row.status).toBe("REJECTED");
  expect(row.rejection_reason).toBe("QA: Shop Act copy is unreadable");
  const notes = await notificationsOf(owner.id, since);
  expect(notes.some((n) => /Shop Act copy is unreadable/.test(`${n.title} ${n.body}`)), `owner notified with the reason: ${JSON.stringify(notes)}`).toBe(true);
  const guest = await anonymous();
  const view = await call(guest, "GET", `/api/shops/${shop.id}`);
  await guest.dispose();
  expect(view.status, "not public").toBe(404);
  expect(await guestFinds(shop.name)).toBe(false);
  return `REJECTED with reason; notification "${notes[0]?.title}"; GET /api/shops/{id} as guest → 404; not in search`;
}, local);

qa("TC-ONB-014", "approving a rejected shop whose Shop Act licence is now held by another shop: 409", async () => {
  const act = uniqueShopAct();
  const x = await verifiedPendingShop("onb014a", { shopActNumber: act });
  expectStatus(await call(await as("ops"), "POST", `/api/shops/${x.shop.id}/reject`, { reason: "QA rejected first" }), 200, "reject X");
  const y = await registerShop(await ctxFor(await freshAccount("onb014b")), { shopActNumber: act });
  expect(y.res.status, "the licence is free again after the rejection").toBe(201);
  const res = await call(await as("ops"), "POST", `/api/shops/${x.shop.id}/approve`, { classification: "GREEN" });
  expect(res.status, why(res)).toBe(409);
  expect((await shopRow(x.shop.id)).status).toBe("REJECTED");
  return `X rejected, Y registered with the same licence, approve X → 409 "${res.body?.error?.message}"`;
}, local);

qa("TC-ONB-015", "classification: the owner gets 403; an operator without a reason is refused; with a reason it is saved to the history", async () => {
  const { ctx, shop } = await approvedShopOfNewOwner("onb015");
  const owner = await call(ctx, "POST", `/api/shops/${shop.id}/classification`, { classification: "KESARI", reason: "I want Kesari" });
  expect(owner.status, why(owner)).toBe(403);
  const noReason = await call(await as("ops"), "POST", `/api/shops/${shop.id}/classification`, { classification: "KESARI" });
  expect(noReason.status, why(noReason)).toBe(422);
  const short = await call(await as("ops"), "POST", `/api/shops/${shop.id}/classification`, { classification: "KESARI", reason: "x" });
  expect(short.status).toBe(422);
  const withReason = await call(await as("ops"), "POST", `/api/shops/${shop.id}/classification`, { classification: "KESARI", reason: "QA: meets the Kesari criteria" });
  expectStatus(withReason, 200, "change with a reason");
  const history = await call(await as("ops"), "GET", `/api/shops/${shop.id}/classification`);
  const rows = (Array.isArray(history.body) ? history.body : (history.body?.history ?? [])) as { newValue: string; reason: string }[];
  expect(rows.some((r) => r.newValue === "KESARI" && r.reason === "QA: meets the Kesari criteria"), JSON.stringify(history.body).slice(0, 300)).toBe(true);
  const ownerHistory = await call(ctx, "GET", `/api/shops/${shop.id}/classification`);
  expect(ownerHistory.status, "the owner cannot read or change it").toBe(403);
  return `owner POST → 403; no reason → 422; with reason → 200 and a history row (${rows.length} rows)`;
}, { ...local, partial: "immutability of the history table is a database property (no update/delete API exists) — not probed further" });

qa("TC-ONB-016", "GST: the owner submits a GSTIN (pending), the operator verifies it; for another shop rejects with a reason; the owner sees each status", async ({ browser }) => {
  await needPanStorage();
  const a = await approvedShopOfNewOwner("onb016a");
  const b = await approvedShopOfNewOwner("onb016b");
  const gstA = gstinFor(uniquePan());
  const gstB = gstinFor(uniquePan());
  const subA = await call(a.ctx, "POST", `/api/shops/${a.shop.id}/gst`, { gstin: gstA.toLowerCase() });
  expectStatus(subA, 200, "submit GSTIN");
  expect(subA.body.gstStatus).toBe("PENDING_VERIFICATION");
  expectStatus(await call(b.ctx, "POST", `/api/shops/${b.shop.id}/gst`, { gstin: gstB }), 200, "submit GSTIN B");
  const verify = await call(await as("ops"), "POST", `/api/shops/${a.shop.id}/gst/verify`, {});
  expectStatus(verify, 200, "verify");
  expect(verify.body.gstStatus).toBe("REGISTERED");
  const reject = await call(await as("ops"), "POST", `/api/shops/${b.shop.id}/gst/reject`, { reason: "QA: legal name does not match" });
  expectStatus(reject, 200, "reject");
  expect(reject.body.gstStatus).toBe("VERIFICATION_FAILED");
  for (const [s, text] of [[a, /Verified|Registered/i], [b, /could not be verified/i]] as const) {
    const { context, page } = await pageFor(browser, s.owner);
    try {
      await page.goto("/shop/manage/gst-pan");
      await expect(page.getByRole("heading", { name: "GST & PAN" })).toBeVisible();
      await expect(page.locator("body")).toContainText(text);
    } finally {
      await context.close();
    }
  }
  return `A: ${gstA} PENDING_VERIFICATION → REGISTERED; B: ${gstB} → VERIFICATION_FAILED with reason; both shown on /shop/manage/gst-pan`;
}, { ...local, partial: "the rejection reason itself is not shown to the owner (only 'could not be verified'); the reason is in the audit log" });

qa(["TC-ONB-017"], "PAN: masked everywhere (owner screen, operator queue, API); reveal is admin-only and audited; a customer, another owner and an operator get 403", async ({ browser }) => {
  await needPanStorage();
  const a = await approvedShopOfNewOwner("onb017a");
  const pan = uniquePan();
  const sub = await call(a.ctx, "POST", `/api/shops/${a.shop.id}/pan`, { panNumber: pan, holderName: "QA Pan Holder" });
  expectStatus(sub, 200, "submit PAN");
  expect(JSON.stringify(sub.body), "the owner's answer carries no full PAN").not.toContain(pan);
  const masked = `XXXXXX${pan.slice(-4)}`;
  const { context, page } = await pageFor(browser, a.owner);
  try {
    await page.goto("/shop/manage/gst-pan");
    await expect(page.getByText(masked)).toBeVisible();
    expect(await page.content(), "owner page has no full PAN").not.toContain(pan);
  } finally {
    await context.close();
  }
  const ops = await pageAs(browser, "ops");
  try {
    await ops.page.goto("/admin/console/compliance");
    expect(await ops.page.content(), "operator queue has no full PAN").not.toContain(pan);
  } finally {
    await ops.context.close();
  }
  const other = await approvedShopOfNewOwner("onb017b");
  const denied: string[] = [];
  for (const [who, ctx] of [["customer", await as("customer")], ["other owner", other.ctx], ["operator", await as("ops")]] as const) {
    const res = await call(ctx, "POST", `/api/shops/${a.shop.id}/pan/reveal`);
    expect(res.status, `${who}: ${why(res)}`).toBe(403);
    expect(res.text).not.toContain(pan);
    denied.push(`${who} 403`);
  }
  const guest = await anonymous();
  const g = await call(guest, "POST", `/api/shops/${a.shop.id}/pan/reveal`);
  await guest.dispose();
  expect(g.status).toBe(401);
  const reveal = await call(await as("admin"), "POST", `/api/shops/${a.shop.id}/pan/reveal`);
  expectStatus(reveal, 200, "admin reveal");
  expect(reveal.body.panNumber).toBe(pan);
  const audits = await auditRows(a.shop.id, "%pan%reveal%");
  expect(audits.length, "reveal audited").toBeGreaterThan(0);
  return `owner and operator screens show ${masked} only; ${denied.join(", ")}, guest 401; admin reveal → full PAN, audit "${audits[0].action}"`;
}, local);

qa("TC-ONB-018", "malformed GSTIN and PAN on the owner's GST/PAN form are refused with a message", async ({ browser }) => {
  await needPanStorage();
  const { ctx, shop, owner } = await approvedShopOfNewOwner("onb018");
  const bad: [string, string, unknown][] = [
    ["GSTIN 14 chars", "gst", { gstin: "27ABCDE1234F1Z" }],
    ["GSTIN symbols", "gst", { gstin: "27ABCDE1234F1Z!" }],
    ["PAN ABCDE12345", "pan", { panNumber: "ABCDE12345", holderName: "QA" }],
    ["PAN 9 chars", "pan", { panNumber: "ABCDE1234", holderName: "QA" }],
  ];
  for (const [label, path, body] of bad) {
    const res = await call(ctx, "POST", `/api/shops/${shop.id}/${path}`, body);
    expect(res.status, `${label}: ${why(res)}`).toBe(422);
  }
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/manage/gst-pan");
    await page.getByLabel("PAN number").fill("ABCDE12345");
    await page.getByLabel("Name on PAN card").fill("QA Holder");
    await page.getByRole("button", { name: "Submit PAN" }).click();
    await expect(page.getByText(/PAN must be 10 characters in the format AAAAA9999A/)).toBeVisible();
    await page.getByLabel("GSTIN").fill("27ABCDE1234F1Z");
    await expect(page.getByRole("button", { name: /Submit GSTIN/ })).toBeDisabled();
  } finally {
    await context.close();
  }
  return "14-char and symbol GSTIN, ABCDE12345 and 9-char PAN → 422; the form shows the PAN message and keeps Submit GSTIN off below 15 characters";
}, { ...local, partial: "state-code and check-character validation of the GSTIN is TC-FLD-043" });

/* ------------------------------------------------- fees and payments */

/** Sets the registration fee for the duration of `body` and restores the schedule. */
async function withFee<T>(amountPaise: number, body: (setFee: (paise: number) => Promise<void>) => Promise<T>): Promise<T> {
  const admin = await as("admin");
  const before = await call(admin, "GET", "/api/registration-fees");
  expectStatus(before, 200, "GET registration fees");
  const previous = before.body.active as { id: string; amountPaise: number } | null;
  const created: string[] = [];
  const setFee = async (paise: number) => {
    const res = await call(admin, "POST", "/api/registration-fees", { amountPaise: paise, reason: `QA ${RUN}` });
    expectStatus(res, 201, "set the registration fee");
    created.push(res.body.id);
  };
  await setFee(amountPaise);
  try {
    return await body(setFee);
  } finally {
    if (previous) {
      await call(admin, "POST", "/api/registration-fees", { amountPaise: previous.amountPaise, reason: `QA ${RUN} restore` });
    } else {
      // There was no schedule: switch off the rows this check added.
      await db()`update registration_fees set is_active = false where id = any(${created})`;
    }
  }
}

qa("TC-ONB-021", "registration fee: a new shop snapshots the fee at registration; a later change does not alter it; fee history is kept", async () => {
  const result = await withFee(50_000, async (setFee) => {
    const { shop } = await registerShop(await ctxFor(await freshAccount("onb021")));
    const first = await shopRow(shop.id);
    expect(Number(first.registration_fee_paise)).toBe(50_000);
    expect(first.fee_payment_status).toBe("PENDING");
    await setFee(75_000);
    const after = await shopRow(shop.id);
    expect(Number(after.registration_fee_paise), "snapshot unchanged").toBe(50_000);
    const { shop: later } = await registerShop(await ctxFor(await freshAccount("onb021b")));
    expect(Number((await shopRow(later.id)).registration_fee_paise)).toBe(75_000);
    const fees = await call(await as("admin"), "GET", "/api/registration-fees");
    const history = fees.body.history as { previousAmountPaise: number | null; newAmountPaise: number }[];
    expect(history.some((h) => h.previousAmountPaise === 50_000 && h.newAmountPaise === 75_000), "history row 500 → 750").toBe(true);
    return `shop at ₹500 kept ₹500 after the fee became ₹750; a later shop got ₹750; history has ${history.length} rows`;
  });
  return result;
}, local);

qa(["TC-ONB-022", "TC-ONB-023"], "fee payments: part then balance (PENDING → PARTIALLY_PAID → PAID), a reversal recalculates; payments cannot be edited or deleted; approval is refused while the fee is unpaid and succeeds once paid", async () => {
  return withFee(50_000, async () => {
    const owner = await freshAccount("onb022");
    const { shop } = await registerShop(await ctxFor(owner));
    await markDocumentsVerified(shop.id);
    const ops = await as("ops");
    const blockedApprove = await call(ops, "POST", `/api/shops/${shop.id}/approve`, { classification: "GREEN" });
    expect(blockedApprove.status, `approve with fee unpaid: ${why(blockedApprove)}`).toBe(409);
    expect((await shopRow(shop.id)).lifecycle_status).toBe("PAYMENT_PENDING");
    const part = await call(ops, "POST", "/api/shop-payments", { shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 20_000, method: "UPI", transactionId: `qa-${RUN}-1` });
    expectStatus(part, 201, "part payment");
    expect(part.body.feePaymentStatus).toBe("PARTIALLY_PAID");
    const stillBlocked = await call(ops, "POST", `/api/shops/${shop.id}/approve`, { classification: "GREEN" });
    expect(stillBlocked.status, "part-paid still blocks approval").toBe(409);
    const rest = await call(ops, "POST", "/api/shop-payments", { shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 30_000, method: "CASH" });
    expectStatus(rest, 201, "balance");
    expect(rest.body.feePaymentStatus).toBe("PAID");
    const paymentId = part.body.payment.id as string;
    for (const method of ["PATCH", "DELETE", "PUT"] as const) {
      const res = await call(ops, method, `/api/shop-payments/${paymentId}`, method === "DELETE" ? undefined : { amountPaise: 1 });
      expect([404, 405], `${method} a payment → ${res.status}`).toContain(res.status);
    }
    const reversed = await call(ops, "POST", `/api/shop-payments/${paymentId}/reverse`, { reason: "QA: recorded twice" });
    expectStatus(reversed, [200, 201], "reverse");
    const afterReverse = await shopRow(shop.id);
    expect(Number(afterReverse.amount_paid_paise)).toBe(30_000);
    expect(afterReverse.fee_payment_status).toBe("PARTIALLY_PAID");
    expectStatus(await call(ops, "POST", "/api/shop-payments", { shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 20_000, method: "UPI" }), 201, "pay again");
    expect((await shopRow(shop.id)).fee_payment_status).toBe("PAID");
    const approved = await call(ops, "POST", `/api/shops/${shop.id}/approve`, { classification: "GREEN" });
    expectStatus(approved, 200, "approve once paid");
    const history = await call(ops, "GET", `/api/shop-payments?shopId=${shop.id}`);
    const types = (history.body.payments as { paymentType: string }[]).map((p) => p.paymentType);
    expect(types).toContain("REVERSAL");
    return `₹500 fee: approve → 409; ₹200 → PARTIALLY_PAID (approve still 409); ₹300 → PAID; PATCH/PUT/DELETE a payment refused; reversal of ₹200 → paid ₹300, PARTIALLY_PAID; paid again → PAID → approved; ${types.length} ledger rows incl. REVERSAL`;
  });
}, local);

qa("TC-ONB-024", "the owner sees the own registration and payment history (read-only); another shop's payments are refused", async ({ browser }) => {
  const a = await approvedShopOfNewOwner("onb024a");
  const b = await approvedShopOfNewOwner("onb024b");
  const own = await call(a.ctx, "GET", `/api/shop-payments?shopId=${a.shop.id}`);
  expectStatus(own, 200, "own payments");
  const otherShop = await call(a.ctx, "GET", `/api/shop-payments?shopId=${b.shop.id}`);
  expect(otherShop.status, why(otherShop)).toBe(403);
  const all = await call(a.ctx, "GET", "/api/shop-payments");
  expect(all.status, "no shop = everyone's: refused").toBe(403);
  const write = await call(a.ctx, "POST", "/api/shop-payments", { shopId: a.shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 100 });
  expect(write.status, "an owner cannot record a payment").toBe(403);
  const { context, page } = await pageFor(browser, a.owner);
  try {
    await page.goto("/shop/manage/registration");
    await expect(page.getByRole("heading", { name: "Registration and fee" })).toBeVisible();
    await expect(page.locator("main")).toContainText(String((await shopRow(a.shop.id)).registration_number));
    await expect(page.getByRole("button", { name: /record|reverse|edit/i })).toHaveCount(0);
  } finally {
    await context.close();
  }
  return "own history 200; other shop 403; all 403; owner POST 403; /shop/manage/registration shows the registration number with no edit controls";
}, local);

qa("TC-ONB-025", "shop referral codes: an operator creates a code, a shop registers with it, the code's performance count rises", async ({ browser }) => {
  const code = `QA${RUN}`.toUpperCase().slice(0, 16);
  const ops = await as("ops");
  const created = await call(ops, "POST", "/api/referral-codes", { code, label: "QA sellers", referrerName: "QA Partner" });
  expectStatus(created, 201, "create a referral code");
  const shopsColumn = async () => {
    const { context, page } = await pageAs(browser, "ops");
    try {
      await page.goto("/admin/console/referral-codes");
      const row = page.getByRole("row").filter({ hasText: code }).first();
      await expect(row).toBeVisible();
      return Number((await row.getByRole("cell").nth(3).innerText()).trim());
    } finally {
      await context.close();
    }
  };
  const before = await shopsColumn();
  const { shop } = await registerShop(await ctxFor(await freshAccount("onb025")), { referralCode: code.toLowerCase() });
  const [row] = await db()<{ referral_code_id: string | null }[]>`select referral_code_id from shops where id = ${shop.id}`;
  expect(row.referral_code_id, "shop attributed to the code").toBe(created.body.id);
  const after = await shopsColumn();
  expect(after, "Shops count on the referral screen").toBe(before + 1);
  const report = await call(ops, "GET", "/api/referral-codes?report=1");
  expect(report.status, `GET /api/referral-codes?report=1 (the performance report) — ${why(report)}`).toBe(200);
  return `code ${code}: Shops ${before} → ${after} on /admin/console/referral-codes; shop.referral_code_id set; performance API 200`;
}, local);

/* --------------------------------------------------------- categories */

qa(["TC-ONB-026", "TC-FLD-080"], "shop categories (admin): add, rename and deactivate with a Save confirmation; names validated (blank, spaces, 1 char, 81+, case duplicate refused; script kept as text; Marathi; trimmed); 'General' cannot be removed; removing a product category keeps its products", async ({ browser }) => {
  const admin = await as("admin");
  const notes: string[] = [];
  for (const [label, name] of [["blank", ""], ["spaces", "    "], ["1 char", "Q"], ["81 chars", "Q".repeat(81)], ["301 chars", "Q".repeat(301)]] as const) {
    const res = await call(admin, "POST", "/api/shop-categories", { name });
    expect(res.status, `${label}: ${why(res)}`).toBe(422);
    notes.push(`${label} 422`);
  }
  const base = `QA Kind ${RUN}`;
  const spaced = await call(admin, "POST", "/api/shop-categories", { name: `   ${base}   ` });
  expectStatus(spaced, 201, "create (trimmed)");
  expect(spaced.body.name).toBe(base);
  const dupCase = await call(admin, "POST", "/api/shop-categories", { name: base.toUpperCase() });
  expect(dupCase.status, "duplicate in another case").toBe(409);
  const script = await call(admin, "POST", "/api/shop-categories", { name: `<script>alert(1)</script> ${RUN}` });
  expectStatus(script, 201, "script text");
  expect(script.body.name).toBe(`<script>alert(1)</script> ${RUN}`);
  const marathi = await call(admin, "POST", "/api/shop-categories", { name: `किराणा दुकान ${RUN}` });
  notes.push(`Marathi → ${marathi.status} ${marathi.body?.name ?? why(marathi)}`);
  // UI: add one with the Save bar, rename it, deactivate it.
  const uiName = `QA UI Kind ${RUN}`;
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/shop-categories");
    await page.getByRole("tab", { name: "Add a category" }).click();
    await page.getByLabel("Name", { exact: true }).fill(uiName);
    await page.getByTestId("category-create-save").getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText(`Category created: ${uiName}`)).toBeVisible();
  } finally {
    await context.close();
  }
  const list = await call(admin, "GET", `/api/shop-categories?all=1&q=${encodeURIComponent(uiName)}`);
  const ui = (list.body.categories as { id: string; name: string }[]).find((c) => c.name === uiName);
  expect(ui, "created from the screen").toBeTruthy();
  const renamed = await call(admin, "PATCH", `/api/shop-categories/${ui!.id}`, { name: `${uiName} Renamed` });
  expectStatus(renamed, 200, "rename");
  const off = await call(admin, "PATCH", `/api/shop-categories/${ui!.id}`, { status: "INACTIVE" });
  expectStatus(off, 200, "deactivate");
  const del = await call(admin, "DELETE", `/api/shop-categories/${ui!.id}`);
  expect([404, 405], "shop categories are deactivated, never deleted").toContain(del.status);
  // 'General' is the permanent product category; removing a product category moves its products to General.
  const cats = await call(admin, "GET", "/api/product-categories?all=1");
  const general = (cats.body.categories as { id: string; name: string; isSystem: boolean }[]).find((c) => c.isSystem || c.name === "General");
  expect(general, "General exists").toBeTruthy();
  const delGeneral = await call(admin, "DELETE", `/api/product-categories/${general!.id}`);
  expect(delGeneral.status, `delete General: ${why(delGeneral)}`).toBeGreaterThanOrEqual(400);
  expect(delGeneral.status).toBeLessThan(500);
  const renameGeneral = await call(admin, "PATCH", `/api/product-categories/${general!.id}`, { name: "Not General" });
  expect(renameGeneral.status).toBeGreaterThanOrEqual(400);
  const temp = await call(admin, "POST", "/api/product-categories", { name: `QA Temp Cat ${RUN}`, department: "DAIRY" });
  expectStatus(temp, 201, "temp product category");
  const [product] = await db()<{ id: string }[]>`
    insert into products (category_id, name, slug, unit, unit_size_milli, kind, approval_status, is_active)
    values (${temp.body.id}, ${`QA Temp Product ${RUN}`}, ${`qa-temp-product-${RUN}`}, 'piece', 1000, 'PACKAGED', 'APPROVED', true) returning id`;
  const removed = await call(admin, "DELETE", `/api/product-categories/${temp.body.id}`);
  expectStatus(removed, 200, "remove a product category");
  const [moved] = await db()<{ category_id: string; deleted_at: Date | null }[]>`select category_id, deleted_at from products where id = ${product.id}`;
  expect(moved.deleted_at, "product not deleted").toBeNull();
  expect(moved.category_id, "product moved to General").toBe(general!.id);
  // The test categories leave every picker again.
  for (const id of [spaced.body?.id, script.body?.id, marathi.body?.id].filter(Boolean)) {
    await call(admin, "PATCH", `/api/shop-categories/${id}`, { status: "INACTIVE" });
  }
  expect(marathi.status, `a Marathi category name must save — ${notes.join("; ")}`).toBe(201);
  return `${notes.join(", ")}; trimmed, case duplicate 409, script stored as text; UI add with "Category created" confirmation; rename + deactivate; DELETE not offered; General delete → ${delGeneral.status}, rename → ${renameGeneral.status}; removing a category moved its product to General`;
}, local);

qa("TC-ONB-027", "an operator adds two categories to a shop and removes one (/admin/shops/{id}/categories): saved, and the shop is listed under each", async () => {
  const { shop } = await approvedShopOfNewOwner("onb027");
  const ops = await as("ops");
  const bakery = await shopCategoryId("Bakery");
  const dairy = await shopCategoryId("Dairy Shop").catch(async () => shopCategoryId("Dairy"));
  const stationery = await shopCategoryId("Stationery Store");
  const put = await call(ops, "PUT", `/api/shops/${shop.id}/categories`, { categoryIds: [stationery, bakery, dairy] });
  expectStatus(put, 200, "add two categories");
  expect(put.body.added.length).toBe(2);
  const remove = await call(ops, "PUT", `/api/shops/${shop.id}/categories`, { categoryIds: [stationery, bakery] });
  expectStatus(remove, 200, "remove one");
  const now = (remove.body.categories as { id: string }[]).map((c) => c.id).sort();
  expect(now).toEqual([stationery, bakery].sort());
  for (const id of [stationery, bakery]) {
    const inCat = await call(ops, "GET", `/api/shop-categories/${id}`);
    expect((inCat.body.shops as { id: string }[]).some((s) => s.id === shop.id), `shop listed under ${id}`).toBe(true);
  }
  const notDairy = await call(ops, "GET", `/api/shop-categories/${dairy}`);
  expect((notDairy.body.shops as { id: string }[]).some((s) => s.id === shop.id)).toBe(false);
  const empty = await call(ops, "PUT", `/api/shops/${shop.id}/categories`, { categoryIds: [] });
  expect(empty.status, "at least one stays").toBe(422);
  return `+Bakery +Dairy then −Dairy: saved; the shop is listed under Stationery and Bakery, not Dairy; [] refused`;
}, { ...local, partial: "shop categories are an internal grouping, not a customer browsing filter (services/shops.ts:1139 'not shown to customers as browsing') — expected 'shows under each category on the storefront' superseded; product categories and the stock-100 fill are TC-CAT-053" });

qa("TC-ONB-028", "category permissions: an owner cannot create or delete shop categories or change another shop's; may change the own shop's and add a product category to it", async () => {
  const a = await approvedShopOfNewOwner("onb028a");
  const b = await approvedShopOfNewOwner("onb028b");
  const create = await call(a.ctx, "POST", "/api/shop-categories", { name: `QA Owner Kind ${RUN}` });
  expect(create.status, `owner creates a shop category: ${why(create)}`).toBe(403);
  const anyCategory = await shopCategoryId("Bakery");
  const patch = await call(a.ctx, "PATCH", `/api/shop-categories/${anyCategory}`, { status: "INACTIVE" });
  expect(patch.status).toBe(403);
  const del = await call(a.ctx, "DELETE", `/api/shop-categories/${anyCategory}`);
  expect([403, 405]).toContain(del.status);
  const cross = await call(a.ctx, "PUT", `/api/shops/${b.shop.id}/categories`, { categoryIds: [anyCategory] });
  expect(cross.status, `owner changes another shop: ${why(cross)}`).toBe(403);
  const own = await call(a.ctx, "PUT", `/api/shops/${a.shop.id}/categories`, { categoryIds: [anyCategory, await shopCategoryId("Stationery Store")] });
  expectStatus(own, 200, "owner changes the own shop's categories");
  // A product category with no products: the add itself is what is being allowed.
  const empty = await call(await as("admin"), "POST", "/api/product-categories", { name: `QA Empty Cat ${RUN}`, department: "DAIRY" });
  expectStatus(empty, 201, "empty product category");
  const addOwn = await call(a.ctx, "POST", `/api/shops/${a.shop.id}/product-categories`, { categoryId: empty.body.id });
  expect(addOwn.status, why(addOwn)).toBe(201);
  const addOther = await call(a.ctx, "POST", `/api/shops/${b.shop.id}/product-categories`, { categoryId: empty.body.id });
  expect(addOther.status).toBe(403);
  return "POST/PATCH/DELETE /api/shop-categories as owner → 403/405; PUT another shop's categories → 403; own shop → 200; product category add: own 201, other shop 403";
}, local);

/* ------------------------------------------------- operator registers */

qa("TC-ONB-039", "an operator registers a shop for an owner (ownerId honoured); the same body from a customer ignores ownerId and the fee (no escalation)", async () => {
  const target = await freshAccount("onb039owner");
  const viaOps = await call(await as("ops"), "POST", "/api/shops", await registrationBody({ ownerId: target.id, registrationFeePaise: 12_300 }));
  expectStatus(viaOps, 201, "operator registers for the owner");
  expect(viaOps.body.ownerId).toBe(target.id);
  const opsRow = await shopRow(viaOps.body.id);
  expect(Number(opsRow.registration_fee_paise)).toBe(12_300);
  const [role] = await db()<{ role: string }[]>`select role from users where id = ${target.id}`;
  expect(role.role, "the owner becomes SHOP_OWNER").toBe("SHOP_OWNER");
  const customer = await freshAccount("onb039cust");
  const self = await call(await ctxFor(customer), "POST", "/api/shops", await registrationBody({ ownerId: target.id, registrationFeePaise: 1 }));
  expectStatus(self, 201, "customer registers with ownerId/fee in the body");
  expect(self.body.ownerId, "ownerId ignored").toBe(customer.id);
  const selfRow = await shopRow(self.body.id);
  expect(Number(selfRow.registration_fee_paise), "fee field ignored").not.toBe(1);
  return `operator → shop owned by ${target.label} with fee ₹123; customer → own shop, ownerId and fee ignored (fee ${selfRow.registration_fee_paise})`;
}, local);

/* ---------------------------------------------------- onboarding stages */

qa(["TC-ONB-040", "TC-CAT-054"], "onboarding stages KYC_PENDING → PAYMENT_PENDING → VERIFIED → ACTIVE, shown to the owner and to operations; listed only when ACTIVE; the registration category does not fill the inventory", async ({ browser }) => {
  await needPanStorage();
  return withFee(30_000, async () => {
    const owner = await freshAccount("onb040");
    const ctx = await ctxFor(owner);
    const { shop } = await registerShop(ctx, { panNumber: uniquePan(), panHolderName: "QA Holder" });
    const seen: string[] = [];
    const stage = async () => (await shopRow(shop.id)).lifecycle_status;
    const ownerSees = async (text: RegExp) => {
      const { context, page } = await pageFor(browser, owner);
      try {
        await page.goto("/shop/manage/today");
        await expect(page.getByTestId("onboarding-stage")).toContainText(text);
      } finally {
        await context.close();
      }
    };
    const opsSees = async (text: RegExp) => {
      const res = await call(await as("ops"), "GET", `/api/shops/${shop.id}`);
      expect(res.body.lifecycleStatus ?? (await stage())).toMatch(text);
    };
    expect(await stage()).toBe("KYC_PENDING");
    await ownerSees(/kyc|documents/i);
    seen.push("KYC_PENDING");
    expect(await guestFinds(shop.name)).toBe(false);
    // Operations verify the documents (the KYC upload itself is TC-ONB-044).
    await markDocumentsVerified(shop.id);
    expect(await stage()).toBe("PAYMENT_PENDING");
    await ownerSees(/payment|fee/i);
    await opsSees(/PAYMENT_PENDING/);
    seen.push("PAYMENT_PENDING");
    expect(await guestFinds(shop.name)).toBe(false);
    expectStatus(await call(await as("ops"), "POST", "/api/shop-payments", { shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 30_000, method: "UPI" }), 201, "fee paid");
    expect(await stage()).toBe("VERIFIED");
    await ownerSees(/verified/i);
    await opsSees(/VERIFIED/);
    seen.push("VERIFIED");
    expect(await guestFinds(shop.name)).toBe(false);
    expectStatus(await call(await as("ops"), "POST", `/api/shops/${shop.id}/approve`, { classification: "GREEN" }), 200, "approve");
    expect(await stage()).toBe("ACTIVE");
    seen.push("ACTIVE");
    expect(await guestFinds(shop.name), "listed once ACTIVE").toBe(true);
    const listings = await call(ctx, "GET", `/api/shops/${shop.id}/products`);
    const count = (Array.isArray(listings.body) ? listings.body : []).length;
    return `${seen.join(" → ")}; owner's onboarding banner and the operator API follow each step; listed only when ACTIVE. TC-CAT-054: the registration (shop) category filled ${count} listings on approval — only product categories added later fill the inventory`;
  });
}, { ...local, partial: "documents are marked verified in the database here; the upload and review path is TC-ONB-044 / TC-ONB-047" });

qa("TC-ONB-041", "a shop in KYC_PENDING, PAYMENT_PENDING or VERIFIED is not listed and its product cannot be added to a cart", async () => {
  return withFee(10_000, async () => {
    const category = (world() as unknown as { category?: { id: string } }).category;
    const out: string[] = [];
    for (const target of ["KYC_PENDING", "PAYMENT_PENDING", "VERIFIED"] as const) {
      const owner = await freshAccount(`onb041${target.toLowerCase()}`);
      const ctx = await ctxFor(owner);
      const { shop } = await registerShop(ctx);
      if (target !== "KYC_PENDING") await markDocumentsVerified(shop.id);
      if (target === "VERIFIED") await db()`update shops set fee_payment_status = 'PAID' where id = ${shop.id}`;
      expect((await shopRow(shop.id)).lifecycle_status).toBe(target);
      // The owner lists products while waiting (the onboarding banner says they may).
      if (!category) throw new Error("the world has no QA category");
      const add = await call(ctx, "POST", `/api/shops/${shop.id}/product-categories`, { categoryId: category.id });
      expectStatus(add, [200, 201], "owner adds the QA category");
      const own = await call(ctx, "GET", `/api/shops/${shop.id}/products`);
      const priced = (own.body as { id: string; onlineSaleEnabled: boolean }[]).find((l) => l.onlineSaleEnabled);
      expect(priced, "a priced listing").toBeTruthy();
      expect(await guestFinds(shop.name), `${target} listed`).toBe(false);
      const cart = await call(await as("customer"), "POST", "/api/cart", { shopProductId: priced!.id, quantity: 1 });
      expect(cart.status, `${target} add to cart: ${why(cart)}`).toBeGreaterThanOrEqual(400);
      expect(cart.status).toBeLessThan(500);
      out.push(`${target}: not listed, cart ${cart.status}`);
    }
    return out.join("; ");
  });
}, local);

qa("TC-ONB-043", "illegal transitions: KYC_PENDING → ACTIVE and REJECTED → ACTIVE (documents unverified) and CLOSED → ACTIVE are refused, state unchanged", async () => {
  const ops = await as("ops");
  const kyc = await registerShop(await ctxFor(await freshAccount("onb043a")));
  const r1 = await call(ops, "POST", `/api/shops/${kyc.shop.id}/approve`, { classification: "GREEN" });
  expect(r1.status, why(r1)).toBe(409);
  expect((await shopRow(kyc.shop.id)).lifecycle_status).toBe("KYC_PENDING");
  const rej = await registerShop(await ctxFor(await freshAccount("onb043b")));
  expectStatus(await call(ops, "POST", `/api/shops/${rej.shop.id}/reject`, { reason: "QA rejected" }), 200, "reject");
  const r2 = await call(ops, "POST", `/api/shops/${rej.shop.id}/approve`, { classification: "GREEN" });
  expect(r2.status, why(r2)).toBe(409);
  expect((await shopRow(rej.shop.id)).status).toBe("REJECTED");
  // CLOSED: a shop that was closed (deleted) — arranged in the database, as no screen closes a shop (TC-ONB-042).
  const closed = await registerShop(await ctxFor(await freshAccount("onb043c")));
  await markDocumentsVerified(closed.shop.id);
  await db()`update shops set fee_payment_status = 'PAID', deleted_at = now() where id = ${closed.shop.id}`;
  expect((await shopRow(closed.shop.id)).lifecycle_status).toBe("CLOSED");
  const r3 = await call(ops, "POST", `/api/shops/${closed.shop.id}/approve`, { classification: "GREEN" });
  const after = await shopRow(closed.shop.id);
  expect(r3.status, `approve a CLOSED shop → ${r3.status}, now ${after.status}/${after.lifecycle_status}`).toBeGreaterThanOrEqual(400);
  expect(after.status, "status unchanged").toBe("PENDING_APPROVAL");
  return `KYC_PENDING approve → 409; REJECTED approve → 409 (documents unverified); CLOSED approve → ${r3.status}; states unchanged`;
}, { ...local, partial: "a REJECTED shop whose documents are all verified may be approved directly — the path TC-ONB-014 relies on (shop-onboarding.ts:80 'covers approving a REJECTED shop directly')" });

qa("TC-ONB-042", "the owner closes the shop: CLOSED, gone from search, the open order settled by rule, reopening needs operations", async ({ browser }) => {
  const { owner, ctx, shop } = await approvedShopOfNewOwner("onb042");
  const patch = await call(ctx, "PATCH", `/api/shops/${shop.id}`, { status: "CLOSED" });
  const closedFlag = await call(ctx, "PATCH", `/api/shops/${shop.id}`, { closed: true });
  const { context, page } = await pageFor(browser, owner);
  let controls = 0;
  try {
    for (const path of ["/shop", "/shop/manage/today", "/shop/manage/hours", "/shop/manage/location"]) {
      await page.goto(path);
      controls += await page.getByRole("button", { name: /close (my|the|this)? ?shop|close permanently|deactivate shop/i }).count();
    }
  } finally {
    await context.close();
  }
  expect(controls, `no way for the owner to close the shop: no control on /shop, /shop/manage/{today,hours,location}; PATCH {status:"CLOSED"} → ${patch.status}, {closed:true} → ${closedFlag.status}`).toBeGreaterThan(0);
  return "close control found";
}, local);
