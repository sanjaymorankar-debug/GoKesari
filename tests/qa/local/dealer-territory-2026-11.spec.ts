/**
 * Territory dealers (DT-24 … DT-27, PR #419; docs/dealer-programme/TERRITORY_DEALER.md;
 * scenarios TS-TERR-01 … 05) on the local server.
 *
 * Local tier: rule territoryDealer is off by default; each check switches it on
 * (with dealer_programme_enabled and rule dealerTieredCommission) through the
 * admin API and puts it back, and cancels its territories in finally so their
 * pincodes are free for the next check (lib/dealer-territory-helpers.ts).
 * Each check makes its own TIERED dealer (lib/dealer-commission-helpers.ts
 * dealerOnly) with his own account. Order income comes from real orders of the
 * world's shops A / B (pincode 411038) delivered by the world's rider, with
 * GoKesari's 2% commission set on the shop for the check. Dates (paid-up date,
 * lapse, grace, the month an order counts in) are moved in the local database;
 * the jobs themselves run for real: the daily cron and the month close.
 * Online fees run through the local SANDBOX gateway page and its signed webhook.
 */
import { test, type Browser, type Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { withFlags } from "../lib/billing-v2-helpers";
import { accruals, activatedShop, commissionAction, dealerOnly, tieredNetwork } from "../lib/dealer-commission-helpers";
import { notesOf } from "../lib/dealer-team-helpers";
import {
  backdate,
  cancelAll,
  closeMonth,
  delivered,
  emptyPincode,
  emptyPincodes,
  feeOnSandbox,
  feeRows,
  freeMonth,
  freePincodes,
  give,
  heldPins,
  holders,
  midMonth,
  movePaidUntil,
  myTerritories,
  myTerritory,
  nextMonth,
  payOffline,
  puneEmptyPincode,
  refundGoods,
  rs,
  shareOf,
  shopA,
  shopB,
  TEST_PIN,
  territorial,
  territoryAction,
  territoryCard,
  territoryDaily,
  territoryEntries,
  territoryRow,
  withCommission,
} from "../lib/dealer-territory-helpers";

import { db } from "../lib/db";
import { withRules } from "../lib/finance-helpers";
import { anonymous, call, expectStatus, RUN, stash, unstash } from "../lib/http";
import { intentRows, postSandboxWebhook } from "../lib/money-helpers";
import { abandon, listingOf, placeSimple } from "../lib/orders-helpers";
import { blocked, expect, need, qa } from "../lib/record";
import { approvedShopOfNewOwner, ctxFor, freshAccount, pageFor, type Account } from "../lib/sellers-helpers";

// Owner, 21-Nov-2026: a territory and a franchise are the same thing. The territory rule is retired (off, and
// refused in Admin → Settings) and its admin page redirects to Admin → Franchise; franchise checks cover this now.
test.skip(true, "Retired 21-Nov-2026: territories are sold as franchise zones (TC-TERR-*)");

const local = { tier: "local" as const, timeout: 300_000 };
const DAY = 86_400_000;

/** A TIERED dealer with his own account holding the DEALER role (as the dealer approval grants it). */
async function dealer(label: string, options: { standard?: boolean } = {}) {
  const d = await dealerOnly(label, options);
  await db()`update users set role = 'DEALER' where id = ${d.owner.id}`;
  await db()`insert into user_role_grants (user_id, role, source) values (${d.owner.id}, 'DEALER', 'ADMIN') on conflict do nothing`;
  return d;
}

/** The dealer's /dealer page; waits until it has rendered. */
async function dealerPage(browser: Browser, owner: Account, name: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const { context, page } = await pageFor(browser, owner);
  await page.goto("/dealer");
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return { page, close: () => context.close() };
}

/** The UTC-based month arithmetic the server uses (src/server/services/shop-membership.ts addMonths). */
function addMonths(date: Date, months: number): Date {
  const out = new Date(date);
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

/** The last day a paid-up instant covers, as the dealer card prints it ("20 Nov 2027"). */
const lastDay = (at: Date) => new Date(at.getTime() - 1).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** The gateway takes the money for an intent (its own ledger), for `amountPaise`, and returns the webhook body. */
async function gatewayCaptures(intentId: string, amountPaise?: number) {
  const { intent, sandbox } = await intentRows(intentId);
  need(sandbox, "the sandbox gateway's order for the intent");
  const paymentId = `sbxpay_qa${Date.now().toString(36)}`;
  const amount = amountPaise ?? Number(sandbox.amount_paise);
  await db()`update payment_sandbox_orders set status = 'CAPTURED', payment_id = ${paymentId}, method = 'UPI', amount_paise = ${amount}, updated_at = now() where gateway_order_id = ${sandbox.gateway_order_id}`;
  return { type: "PAYMENT_CAPTURED", merchantOrderId: String(intent.merchant_order_id), gatewayOrderId: String(sandbox.gateway_order_id), paymentId, amountPaise: amount };
}

/** The dealer starts paying online (POST /api/dealer/territory): the intent and its sandbox page. */
async function startPayment(owner: Account, territoryId: string) {
  const res = await call(await ctxFor(owner), "POST", "/api/dealer/territory", { territoryId });
  expectStatus(res, 200, "start the online fee payment");
  return { intentId: res.body.intentId as string, checkoutUrl: need(res.body.checkoutUrl as string | null, "a checkout page") };
}

/* ----------------------------------------------------- TS-TERR-01: the territory */

qa("TC-TERR-001", "rule territoryDealer off: giving a territory is refused (409), no card on /dealer, the API lists none, the daily job reports 'rule territoryDealer is off', a month close writes no TERRITORY entry", async ({ browser }) => {
  return withFlags({ dealer_programme_enabled: true, dealer_rating_bonus_enabled: false }, () =>
    withRules({ dealerTieredCommission: { enabled: true }, territoryDealer: { enabled: false } }, async () => {
      const d = await dealer("terr001");
      const pin = await emptyPincode();
      const name = `QA Off ${RUN}`;
      const admin = await pageAs(browser, "admin");
      try {
        await admin.page.goto("/admin/dealers/territories");
        await expect(admin.page.getByTestId("territory-rule")).toContainText("off — no territory can be given or paid");
        await admin.page.getByLabel("Dealer").selectOption(d.dealerId);
        await admin.page.getByLabel("Territory name").fill(name);
        await admin.page.getByPlaceholder("411038, 411029, 411052").fill(pin);
        await admin.page.getByLabel("Yearly fee (₹, GST included)").fill("50000");
        await admin.page.getByRole("button", { name: "Give territory" }).click();
        await expect(admin.page.getByRole("alert").filter({ hasText: /\S/ })).toContainText("Territory dealers are switched off (Admin → Settings → territoryDealer).");
      } finally {
        await admin.context.close();
      }
      const api = await territoryAction({ action: "create", dealerId: d.dealerId, name, pincodes: [pin], feePaise: 5_000_000 });
      expectStatus(api, 409, "give a territory with the rule off");
      expect(api.body.error.message).toBe("Territory dealers are switched off (Admin → Settings → territoryDealer).");
      const { page, close } = await dealerPage(browser, d.owner, d.name);
      try {
        await expect(territoryCard(page)).toHaveCount(0);
      } finally {
        await close();
      }
      expect(await myTerritories(await ctxFor(d.owner)), "the API lists no territories").toEqual([]);
      const job = await territoryDaily();
      expect(job, "the daily job").toEqual({ skipped: "rule territoryDealer is off" });
      // A territory given while the rule was on, with a delivered order in a month closed after it was switched off.
      return withCommission([shopA()], 200, async () => {
        let t: { id: string; name: string } | null = null;
        let order;
        await withRules({ territoryDealer: { enabled: true } }, async () => {
          t = await give(d.dealerId, [TEST_PIN]);
          await payOffline(t.id);
          order = await delivered();
        });
        try {
          const month = await freeMonth();
          await backdate(t!.id, [order!.order_id], midMonth(month));
          const closed = await closeMonth(month);
          expect(await territoryEntries(d.dealerId), "no TERRITORY entry").toEqual([]);
          const shares = await db()`select 1 from dealer_territory_order_shares where order_id = ${order!.order_id}`;
          expect(shares.length, "the order is not worked out").toBe(0);
          return `create 409 (page and API); no card; API []; daily job skipped; ${month} closed (${JSON.stringify(closed).slice(0, 60)}…) with no TERRITORY entry`;
        } finally {
          await withRules({ territoryDealer: { enabled: true } }, () => cancelAll());
        }
      });
    }),
  );
}, { ...local, timeout: 420_000 });

qa("TC-TERR-002", "Admin gives a TIERED dealer 'Pune - Test 1' (411038, 411029 / 411052, 411038, ₹50,000): 'Waiting for the fee', 411029, 411038, 411052, one fee awaiting payment, the dealer told, audited; only TIERED dealers offered", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr002");
    const std = await dealerOnly("terr002s", { standard: true });
    const pins = ["411029", "411038", "411052"];
    await freePincodes(pins);
    const name = `Pune - Test 1 ${RUN}`;
    let id = "";
    try {
      const admin = await pageAs(browser, "admin");
      try {
        await admin.page.goto("/admin/dealers/territories");
        const options = await admin.page.getByLabel("Dealer").locator("option").allTextContents();
        expect(options, "the TIERED dealer is offered").toContain(d.name);
        expect(options, "a STANDARD dealer is not").not.toContain(std.name);
        await admin.page.getByLabel("Dealer").selectOption(d.dealerId);
        await admin.page.getByLabel("Territory name").fill(name);
        await admin.page.getByPlaceholder("411038, 411029, 411052").fill("411038, 411029\n411052, 411038");
        await expect(admin.page.getByText("3 pincodes", { exact: true })).toBeVisible();
        await admin.page.getByLabel("Yearly fee (₹, GST included)").fill("50000");
        await admin.page.getByRole("button", { name: "Give territory" }).click();
        await expect(admin.page.getByRole("status").filter({ hasText: `${name} was given to the dealer; he can now pay the fee.` })).toBeVisible();
        const card = admin.page.getByTestId("territory-card").filter({ hasText: name });
        await expect(card).toContainText("Waiting for the fee");
        await expect(card).toContainText("Pincodes: 411029, 411038, 411052");
        await expect(card).toContainText("Yearly fee: ₹50,000 · paid up to —");
        await card.getByText("Fees (1)").click();
        await expect(card).toContainText("₹50,000 — waiting for payment");
      } finally {
        await admin.context.close();
      }
      const [row] = await db()<{ id: string }[]>`select id from dealer_exclusive_territories where dealer_id = ${d.dealerId} and name = ${name}`;
      id = need(row, "the new territory").id;
      expect(await territoryRow(id)).toMatchObject({ status: "AWAITING_FEE", fee_paise: 5_000_000, paid_until: null });
      expect(await heldPins(id)).toEqual(pins);
      expect((await feeRows(id)).map((f) => [f.amount_paise, f.status])).toEqual([[5_000_000, "AWAITING_PAYMENT"]]);
      const [audit] = await db()<{ v: { created: boolean; pincodes: string[]; feePaise: number } }[]>`select new_value as v from audit_logs where action = 'dealer.territory_changed' and entity_id = ${id}`;
      expect(audit?.v, "audited").toMatchObject({ created: true, pincodes: pins, feePaise: 5_000_000 });
      const note = (await notesOf(await ctxFor(d.owner))).find((x) => x.title === `Your territory ${name}: given to you`);
      expect(note?.body, "the dealer is told").toBe(`GoKesari has given you the territory ${name} (3 pincodes). Pay the yearly fee of ₹50,000 on your dealer page to start earning on every order there.`);
      return `${name}: Waiting for the fee; 411029, 411038, 411052; ₹50,000 awaiting; dealer told; audited; STANDARD dealer not offered`;
    } finally {
      await cancelAll(id ? [id] : []);
    }
  });
}, local);

qa("TC-TERR-003", "a pincode another territory holds is refused (409 'Already held by another territory: 411038 (<dealer>, <territory>).') on create and on Change pincodes, nothing taken; a direct second holder fails on the unique index", async ({ browser }) => {
  return territorial(async () => {
    const d1 = await dealer("terr003a");
    const d2 = await dealer("terr003b");
    try {
      const t1 = await give(d1.dealerId, [TEST_PIN, "411029"], { name: `Pune - Test 1 ${RUN}` });
      const message = `Already held by another territory: 411038 (${d1.name}, ${t1.name}).`;
      await freePincodes(["411045"]);
      const admin = await pageAs(browser, "admin");
      try {
        await admin.page.goto("/admin/dealers/territories");
        await admin.page.getByLabel("Dealer").selectOption(d2.dealerId);
        await admin.page.getByLabel("Territory name").fill(`QA D2 ${RUN}`);
        await admin.page.getByPlaceholder("411038, 411029, 411052").fill("411038, 411045");
        await admin.page.getByLabel("Yearly fee (₹, GST included)").fill("40000");
        await admin.page.getByRole("button", { name: "Give territory" }).click();
        await expect(admin.page.getByRole("alert").filter({ hasText: /\S/ })).toContainText(message);
      } finally {
        await admin.context.close();
      }
      const created = await territoryAction({ action: "create", dealerId: d2.dealerId, name: `QA D2 ${RUN}`, pincodes: [TEST_PIN, "411045"], feePaise: 4_000_000 });
      expectStatus(created, 409, "a held pincode on create");
      expect(created.body.error.message).toBe(message);
      const d2Rows = await db()`select 1 from dealer_exclusive_territories where dealer_id = ${d2.dealerId}`;
      expect(d2Rows.length, "nothing created").toBe(0);
      expect(await holders(["411045"]), "411045 not taken either").toEqual([]);
      const own = await emptyPincode();
      const t2 = await give(d2.dealerId, [own]);
      const changed = await territoryAction({ action: "pincodes", territoryId: t2.id, add: [TEST_PIN], remove: [], reason: "QA: try a held pincode" });
      expectStatus(changed, 409, "a held pincode by Change pincodes");
      expect(changed.body.error.message).toBe(message);
      expect(await heldPins(t2.id), "unchanged").toEqual([own]);
      let error = "";
      try {
        await db()`insert into dealer_territory_pincodes (territory_id, pincode) values (${t2.id}, ${TEST_PIN})`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      expect(error, "the database refuses a second holder").toContain("dealer_territory_pincodes_held_unique");
      return `${message} on the page, the API and Change pincodes; 411045 not taken; direct insert: ${error.slice(0, 90)}`;
    } finally {
      await cancelAll();
    }
  });
}, local);

qa("TC-TERR-004", "field checks on a new territory: bad pincodes, none, 501 (500 accepted), a one-letter name, a fee of 0 / empty — each refused with its message, nothing saved", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr004");
    const issues: string[] = [];
    const notes: string[] = [];
    const base = { action: "create", dealerId: d.dealerId, name: `QA Fields ${RUN}`, feePaise: 5_000_000 };
    try {
      const bad = await territoryAction({ ...base, pincodes: ["41103", "0411038", "4110388", "abcdef"] });
      expectStatus(bad, 422, "bad pincodes");
      const badMessage = bad.body.error.message as string;
      expect(badMessage.startsWith("These are not 6-digit pincodes: "), badMessage).toBe(true);
      for (const p of ["41103", "0411038", "4110388", "abcdef"]) expect(badMessage).toContain(p);
      if (badMessage !== "These are not 6-digit pincodes: 41103, 0411038, 4110388, abcdef.") notes.push(`bad pincodes listed as "${badMessage}"`);
      const none = await territoryAction({ ...base, pincodes: [] });
      expectStatus(none, 422, "no pincode");
      expect(none.body.error.message).toBe("Give at least one pincode.");
      const pins = await emptyPincodes(501);
      const tooMany = await territoryAction({ ...base, pincodes: pins });
      expectStatus(tooMany, 422, "501 pincodes");
      if (tooMany.body.error.message !== "At most 500 pincodes in one territory.") issues.push(`501 pincodes: "${tooMany.body.error.message}" ${JSON.stringify(tooMany.body.error.details ?? {})}`);
      const shortName = await territoryAction({ ...base, name: "P", pincodes: [pins[0]] });
      expectStatus(shortName, 422, "name P");
      expect(shortName.body.error.message).toBe("Give the territory a name.");
      const zero = await territoryAction({ ...base, pincodes: [pins[0]], feePaise: 0 });
      expectStatus(zero, 422, "fee 0");
      if (zero.body.error.message !== "Give the yearly fee in rupees (at least ₹1).") issues.push(`fee 0: "${zero.body.error.message}" ${JSON.stringify(zero.body.error.details ?? {})}`);
      const empty = await territoryAction({ action: "create", dealerId: d.dealerId, name: base.name, pincodes: [pins[0]] });
      expectStatus(empty, 422, "no fee");
      const saved = await db()`select 1 from dealer_exclusive_territories where dealer_id = ${d.dealerId}`;
      expect(saved.length, "nothing saved").toBe(0);
      // The page: invalid input keeps "Give territory" disabled; 501 pincodes are sent and answered.
      const admin = await pageAs(browser, "admin");
      try {
        const p = admin.page;
        await p.goto("/admin/dealers/territories");
        const button = p.getByRole("button", { name: "Give territory" });
        await p.getByLabel("Dealer").selectOption(d.dealerId);
        await p.getByLabel("Territory name").fill(base.name);
        await p.getByLabel("Yearly fee (₹, GST included)").fill("50000");
        await p.getByPlaceholder("411038, 411029, 411052").fill("41103, 0411038, 4110388, abcdef");
        await expect(p.getByText("0 pincodes · not valid: 41103, 0411038, 4110388, abcdef")).toBeVisible();
        await expect(button).toBeDisabled();
        await p.getByPlaceholder("411038, 411029, 411052").fill("");
        await expect(button).toBeDisabled();
        await p.getByPlaceholder("411038, 411029, 411052").fill(pins[0]);
        await expect(button).toBeEnabled();
        await p.getByLabel("Territory name").fill("P");
        await expect(button).toBeDisabled();
        await p.getByLabel("Territory name").fill(base.name);
        for (const fee of ["0", ""]) {
          await p.getByLabel("Yearly fee (₹, GST included)").fill(fee);
          await expect(button, `fee "${fee}"`).toBeDisabled();
        }
        await p.getByLabel("Yearly fee (₹, GST included)").fill("50000");
        await p.getByPlaceholder("411038, 411029, 411052").fill(pins.join(", "));
        await expect(p.getByText("501 pincodes", { exact: true })).toBeVisible();
        await button.click();
        const alert = p.getByRole("alert").filter({ hasText: /\S/ });
        await expect(alert).toBeVisible();
        const shown = (await alert.innerText()).trim();
        if (!shown.includes("At most 500 pincodes in one territory.")) issues.push(`501 pincodes on the page: "${shown}"`);
      } finally {
        await admin.context.close();
      }
      const ok = await territoryAction({ ...base, pincodes: pins.slice(0, 500) });
      expectStatus(ok, 200, "500 pincodes");
      await cancelAll([ok.body.territory.id]);
      expect(issues, `the Expected messages${notes.length ? ` (also: ${notes.join("; ")})` : ""}`).toEqual([]);
      return `bad pincodes / none / name P refused with their messages; fee 0 and empty keep the button disabled; 500 accepted${notes.length ? `; note: ${notes.join("; ")}` : ""}`;
    } finally {
      await cancelAll();
    }
  });
}, local);

qa("TC-TERR-005", "only an approved TIERED dealer can hold a territory: STANDARD, not approved and GoKesari's own record are refused (409) with their messages", async () => {
  return territorial(async () => {
    const standard = await dealerOnly("terr005s", { standard: true });
    const pending = await dealerOnly("terr005p");
    await db()`update dealers set status = 'PENDING' where id = ${pending.dealerId}`;
    const [internal] = await db()<{ id: string }[]>`select id from dealers where is_internal and status = 'APPROVED' limit 1`;
    const pin = await emptyPincode();
    const create = (dealerId: string) => territoryAction({ action: "create", dealerId, name: `QA Who ${RUN}`, pincodes: [pin], feePaise: 5_000_000 });
    const s = await create(standard.dealerId);
    expectStatus(s, 409, "a STANDARD dealer");
    expect(s.body.error.message).toBe("Move this dealer to the TIERED model first: a territory dealer keeps the TIERED team and its commission.");
    const p = await create(pending.dealerId);
    expectStatus(p, 409, "a dealer not yet approved");
    expect(p.body.error.message).toBe("Only an approved dealer can be given a territory.");
    const i = await create(need(internal, "GoKesari's internal dealer record (GoKesari Direct)").id);
    expectStatus(i, 409, "GoKesari's own dealer record");
    expect(i.body.error.message).toBe("GoKesari's own dealer record cannot hold a territory.");
    expect(await holders([pin]), "nothing given").toEqual([]);
    return "STANDARD → TIERED first; PENDING → approved only; GoKesari Direct → refused (409 each)";
  });
}, local);

qa("TC-TERR-006", "Change pincodes needs a reason; an added pincode counts orders from then on, a released one stops; releasing every pincode is refused; a released pincode can be given again", async () => {
  return territorial(() =>
    withCommission([shopA()], 200, async () => {
      const d = await dealer("terr006");
      const d2 = await dealer("terr006b");
      try {
        const keep = await emptyPincode();
        const rel = await emptyPincode();
        const t = await give(d.dealerId, [keep, rel]);
        await payOffline(t.id);
        const bare = await territoryAction({ action: "pincodes", territoryId: t.id, add: [TEST_PIN], remove: [rel], reason: "" });
        expectStatus(bare, 422, "no reason");
        expect(bare.body.error.message).toBe("Give the reason for the change (it is kept in the audit log).");
        expect(await heldPins(t.id), "unchanged").toEqual([keep, rel].sort());
        const changed = await territoryAction({ action: "pincodes", territoryId: t.id, add: [TEST_PIN], remove: [rel], reason: "QA: shop A's pincode in, one out" });
        expectStatus(changed, 200, "with a reason");
        expect(changed.body).toEqual({ added: [TEST_PIN], removed: [rel] });
        const [audit] = await db()<{ v: { added: string[]; removed: string[]; reason: string } }[]>`
          select new_value as v from audit_logs where action = 'dealer.territory_changed' and entity_id = ${t.id} and new_value ? 'added' order by created_at desc limit 1`;
        expect(audit.v).toEqual({ added: [TEST_PIN], removed: [rel], reason: "QA: shop A's pincode in, one out" });
        const ctx = await ctxFor(d.owner);
        const counted = await delivered();
        expect((await myTerritory(ctx, t.id)).monthSoFar.orders, "an order delivered after the pincode was added counts").toBe(1);
        expectStatus(await territoryAction({ action: "pincodes", territoryId: t.id, add: [], remove: [TEST_PIN], reason: "QA: release shop A's pincode" }), 200, "release 411038");
        const after = await delivered();
        const view = await myTerritory(ctx, t.id);
        expect(view.monthSoFar.orders, "the order delivered after the release does not count").toBe(1);
        expect(view.monthSoFar.commissionKeptPaise, "only the first order's commission").toBe(counted.commission_paise);
        const all = await territoryAction({ action: "pincodes", territoryId: t.id, add: [], remove: [keep], reason: "QA: release every pincode" });
        expectStatus(all, 409, "release every pincode");
        expect(all.body.error.message).toBe("A territory keeps at least one pincode; cancel it instead.");
        const again = await give(d2.dealerId, [rel]);
        expect(await heldPins(again.id), "the released pincode given again").toEqual([rel]);
        return `no reason 422; +411038 / −${rel} logged; order ${counted.order_number} counted, ${after.order_number} after the release not; last pincode kept (409); ${rel} given to D2`;
      } finally {
        await cancelAll();
      }
    }),
  );
}, { ...local, timeout: 420_000 });

qa("TC-TERR-007", "a new yearly fee needs a reason and applies to the next payment: an open fee being paid online (₹50,000) is cancelled and ₹60,000 made ('Pay ₹60,000 now'); on an Active territory only the next renewal changes; logged", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr007");
    const notes: string[] = [];
    try {
      const t = await give(d.dealerId, [await emptyPincode()], { feePaise: 5_000_000 });
      await startPayment(d.owner, t.id);
      const [open] = await feeRows(t.id);
      expect(open.payment_intent_id, "an online checkout was started").toBeTruthy();
      const bare = await territoryAction({ action: "fee", territoryId: t.id, feePaise: 6_000_000, reason: "" });
      expectStatus(bare, 422, "no reason");
      expectStatus(await territoryAction({ action: "fee", territoryId: t.id, feePaise: 6_000_000, reason: "QA: new fee" }), 200, "₹60,000 with a reason");
      expect((await feeRows(t.id)).map((f) => [f.amount_paise, f.status]), "₹50,000 cancelled, ₹60,000 made").toEqual([
        [5_000_000, "CANCELLED"],
        [6_000_000, "AWAITING_PAYMENT"],
      ]);
      const { page, close } = await dealerPage(browser, d.owner, d.name);
      try {
        await expect(territoryCard(page).getByRole("button", { name: "Pay ₹60,000 now" })).toBeVisible();
      } finally {
        await close();
      }
      // An open fee with no checkout started is re-priced in place.
      expectStatus(await territoryAction({ action: "fee", territoryId: t.id, feePaise: 6_500_000, reason: "QA: re-price" }), 200, "₹65,000");
      const repriced = await feeRows(t.id);
      expect(repriced.map((f) => [f.amount_paise, f.status])).toEqual([
        [5_000_000, "CANCELLED"],
        [6_500_000, "AWAITING_PAYMENT"],
      ]);
      notes.push("an open fee with no checkout started is re-priced in place (no new row)");
      const active = await payOffline(t.id);
      expectStatus(await territoryAction({ action: "fee", territoryId: t.id, feePaise: 7_000_000, reason: "QA: next year's fee" }), 200, "₹70,000 on an Active territory");
      const after = await territoryRow(t.id);
      expect(after.fee_paise, "the next renewal's fee").toBe(7_000_000);
      expect(after.paid_until?.getTime(), "paid-up date unchanged").toBe(active.paid_until?.getTime());
      expect((await feeRows(t.id)).map((f) => [f.amount_paise, f.status]), "the paid fee unchanged, nothing new to pay").toEqual([
        [5_000_000, "CANCELLED"],
        [6_500_000, "PAID"],
      ]);
      const logged = await db()<{ n: number }[]>`select count(*)::int as n from audit_logs where action = 'dealer.territory_changed' and entity_id = ${t.id} and new_value ? 'feePaise' and new_value ? 'reason'`;
      expect(logged[0].n, "each change logged with its reason").toBe(3);
      return `₹50,000 (checkout started) → cancelled + ₹60,000; 'Pay ₹60,000 now'; Active: ₹70,000 for the next renewal only; 3 changes logged; note: ${notes.join("; ")}`;
    } finally {
      await cancelAll();
    }
  });
}, local);

qa("TC-TERR-008", "Cancel territory (with a reason): 'Cancelled', pincodes released, no Pay button; payment and changes refused 'This territory is cancelled.'; its pincode can be given again", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr008");
    const d2 = await dealer("terr008b");
    const issues: string[] = [];
    try {
      const pin = await emptyPincode();
      const t = await give(d.dealerId, [pin]);
      await payOffline(t.id);
      const bare = await territoryAction({ action: "cancel", territoryId: t.id, reason: "" });
      expectStatus(bare, 422, "cancel without a reason");
      expectStatus(await territoryAction({ action: "cancel", territoryId: t.id, reason: "QA: cancel the territory" }), 200, "cancel with a reason");
      expect((await territoryRow(t.id)).status).toBe("CANCELLED");
      expect(await heldPins(t.id), "pincodes released").toEqual([]);
      const { page, close } = await dealerPage(browser, d.owner, d.name);
      try {
        const card = territoryCard(page);
        await expect(card).toContainText("Cancelled");
        await expect(card).toContainText("Pincodes: released");
        await expect(card.getByRole("button", { name: /^Pay ₹/ })).toHaveCount(0);
      } finally {
        await close();
      }
      const pay = await call(await ctxFor(d.owner), "POST", "/api/dealer/territory", { territoryId: t.id });
      expectStatus(pay, 409, "the dealer pays a cancelled territory");
      if (pay.body.error.message !== "This territory is cancelled.") issues.push(`dealer's payment: "${pay.body.error.message}" (expected "This territory is cancelled.")`);
      for (const [what, body] of [
        ["pincodes", { action: "pincodes", territoryId: t.id, add: [await emptyPincode()], remove: [], reason: "QA: after cancel" }],
        ["fee", { action: "fee", territoryId: t.id, feePaise: 6_000_000, reason: "QA: after cancel" }],
        ["recordPayment", { action: "recordPayment", territoryId: t.id, reference: "QA-AFTER-CANCEL" }],
      ] as const) {
        const res = await territoryAction(body);
        expectStatus(res, 409, `${what} after the cancel`);
        expect(res.body.error.message, what).toBe("This territory is cancelled.");
      }
      const twice = await territoryAction({ action: "cancel", territoryId: t.id, reason: "QA: again" });
      expectStatus(twice, 409, "cancel twice");
      expect(twice.body.error.message).toBe("This territory is already cancelled.");
      const again = await give(d2.dealerId, [pin]);
      expect(await heldPins(again.id)).toEqual([pin]);
      const note = (await notesOf(await ctxFor(d.owner))).find((x) => x.title === `Your territory ${t.name}: cancelled`);
      expect(note?.body).toBe(`GoKesari cancelled your territory ${t.name}: QA: cancel the territory. Order income already earned is still paid.`);
      expect(issues, "the Expected messages").toEqual([]);
      return "cancelled with a reason; card Cancelled, Pincodes: released, no Pay; changes and payment 409; given again to D2";
    } finally {
      await cancelAll();
    }
  });
}, { ...local, partial: "'order income already worked out is still paid' is not re-proven here (the month close keeps PAID fee periods and counted orders: TC-TERR-022)" });

/* --------------------------------------------------------- TS-TERR-02: the fee */

qa("TC-TERR-009", "the dealer pays the first fee online on /dealer: 'Waiting for the fee' until the gateway's signed webhook, then 'Active', paid up for 12 months, fee PAID (ONLINE, TERRITORY_FEE), logged", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr009");
    const notes: string[] = [];
    try {
      const t = await give(d.dealerId, [await emptyPincode()], { feePaise: 5_000_000 });
      const { page, close } = await dealerPage(browser, d.owner, d.name);
      try {
        const card = territoryCard(page);
        await expect(card.getByRole("heading", { name: "Your territory" })).toBeVisible();
        await expect(card).toContainText("Waiting for the fee");
        await expect(card).toContainText("GST included. Covers 12 months from the day you pay.");
        await card.getByRole("button", { name: "Pay ₹50,000 now" }).click();
        await page.waitForURL(/\/orders\/pay\/sandbox\//);
        expect((await territoryRow(t.id)).status, "before the webhook").toBe("AWAITING_FEE");
        const before = (await feeRows(t.id))[0];
        expect(before.status, "the fee is not paid before the webhook").toBe("AWAITING_PAYMENT");
        await feeOnSandbox(page, "pay");
        await page.goto("/dealer");
        const after = await territoryRow(t.id);
        expect(after.status).toBe("ACTIVE");
        const paidUntil = need(after.paid_until, "the paid-up date");
        await expect(card).toContainText("Active");
        await expect(card).toContainText(`Paid up to ${lastDay(paidUntil)} · yearly fee ₹50,000`);
        const [fee] = await feeRows(t.id);
        expect(fee).toMatchObject({ status: "PAID", method: "ONLINE" });
        expect(addMonths(need(fee.period_start, "period start"), 12).getTime(), "12 months").toBe(paidUntil.getTime());
        const [intent] = await db()<{ purpose: string; status: string }[]>`select purpose, status from payment_intents where id = ${need(fee.payment_intent_id, "the payment intent")}`;
        expect(intent).toEqual({ purpose: "TERRITORY_FEE", status: "CAPTURED" });
        const [audit] = await db()<{ v: { method: string; amountPaise: number } }[]>`select new_value as v from audit_logs where action = 'dealer.territory_fee_paid' and entity_id = ${t.id}`;
        expect(audit?.v, "logged").toMatchObject({ method: "ONLINE", amountPaise: 5_000_000 });
        const dayBefore = lastDay(new Date(addMonths(need(fee.period_start, "start"), 12).getTime() - DAY + 1));
        if (lastDay(paidUntil) !== dayBefore) notes.push(`the card prints "Paid up to ${lastDay(paidUntil)}" — the same date next year (the fee covers up to the time of payment), not the day before`);
        return `Waiting until the webhook; then Active, "Paid up to ${lastDay(paidUntil)} · yearly fee ₹50,000"; fee PAID ONLINE via a TERRITORY_FEE intent; logged${notes.length ? `; note: ${notes.join("; ")}` : ""}`;
      } finally {
        await close();
      }
    } finally {
      await cancelAll();
    }
  });
}, local);

qa("TC-TERR-010", "a failed and an abandoned online payment leave the territory 'Waiting for the fee' with the Pay button and no fee paid; paying again succeeds: Active with one paid fee", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr010");
    try {
      const t = await give(d.dealerId, [await emptyPincode()], { feePaise: 5_000_000 });
      const { page, close } = await dealerPage(browser, d.owner, d.name);
      try {
        const card = territoryCard(page);
        const payButton = card.getByRole("button", { name: "Pay ₹50,000 now" });
        await payButton.click();
        await page.waitForURL(/\/orders\/pay\/sandbox\//);
        await feeOnSandbox(page, "fail");
        await page.goto("/dealer");
        await expect(card).toContainText("Waiting for the fee");
        await expect(payButton).toBeVisible();
        expect((await feeRows(t.id)).filter((f) => f.status === "PAID"), "no fee paid after the failure").toEqual([]);
        // Pay again, then leave the payment page without paying.
        await payButton.click();
        await page.waitForURL(/\/orders\/pay\/sandbox\//);
        const box = page.getByTestId("sandbox-checkout");
        const usable = await box.getByTestId("sandbox-pay").isVisible().catch(() => false);
        expect(usable, `the payment page opened after a failed attempt offers Pay (shows: "${(await box.innerText().catch(() => "")).replace(/\s+/g, " ").slice(-90)}")`).toBe(true);
        await page.goto("/dealer");
        await expect(card).toContainText("Waiting for the fee");
        expect((await territoryRow(t.id)).status).toBe("AWAITING_FEE");
        // Pay again, with success.
        await payButton.click();
        await page.waitForURL(/\/orders\/pay\/sandbox\//);
        await feeOnSandbox(page, "pay");
        await page.goto("/dealer");
        await expect(card).toContainText("Active");
      } finally {
        await close();
      }
      expect((await feeRows(t.id)).filter((f) => f.status === "PAID").length, "one paid fee").toBe(1);
      return "failed and abandoned attempts leave it waiting with Pay; the next payment makes it Active with one paid fee";
    } finally {
      await cancelAll();
    }
  });
}, local);

qa("TC-TERR-011", "only a matching signed webhook pays the fee: a replay changes nothing (one paid fee, same paid-up date); a capture for another amount pays nothing; a fee whose amount no longer matches its intent is logged 'amount_or_intent_mismatch'", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr011");
    const notes: string[] = [];
    try {
      const t = await give(d.dealerId, [await emptyPincode()]);
      const started = await startPayment(d.owner, t.id);
      const { context, page } = await pageFor(browser, d.owner);
      try {
        await feeOnSandbox(page, "pay", started.checkoutUrl);
      } finally {
        await context.close();
      }
      const paid = await territoryRow(t.id);
      expect(paid.status).toBe("ACTIVE");
      const { intent, sandbox } = await intentRows(started.intentId);
      const replay = await postSandboxWebhook({ type: "PAYMENT_CAPTURED", merchantOrderId: String(intent.merchant_order_id), gatewayOrderId: String(sandbox.gateway_order_id), paymentId: String(sandbox.payment_id), amountPaise: Number(sandbox.amount_paise) });
      expect(replay.status, `replay: ${replay.text}`).toBe(200);
      expect((await feeRows(t.id)).filter((f) => f.status === "PAID").length, "still one paid fee").toBe(1);
      expect((await territoryRow(t.id)).paid_until?.getTime(), "paid-up date unchanged").toBe(paid.paid_until?.getTime());
      // A capture at the gateway for another amount than the fee's intent.
      const t2 = await give(d.dealerId, [await emptyPincode()]);
      const s2 = await startPayment(d.owner, t2.id);
      const wrong = await postSandboxWebhook(await gatewayCaptures(s2.intentId, 4_000_000));
      expect(wrong.status).toBe(200);
      expect((await feeRows(t2.id)).map((f) => f.status), "no fee paid").toEqual(["AWAITING_PAYMENT"]);
      expect((await territoryRow(t2.id)).status).toBe("AWAITING_FEE");
      expect((await intentRows(s2.intentId)).intent.status, "the intent is not captured").not.toBe("CAPTURED");
      notes.push(`a webhook for another amount than the intent: ${wrong.body?.outcome ?? wrong.text.slice(0, 60)} (flagged for support by the payments layer)`);
      // An intent whose amount no longer matches the fee it pays.
      const t3 = await give(d.dealerId, [await emptyPincode()]);
      const s3 = await startPayment(d.owner, t3.id);
      await db()`update dealer_territory_fees set amount_paise = amount_paise + 100 where territory_id = ${t3.id} and status = 'AWAITING_PAYMENT'`;
      const mismatch = await postSandboxWebhook(await gatewayCaptures(s3.intentId));
      expect(mismatch.status).toBe(200);
      expect((await feeRows(t3.id)).map((f) => f.status), "no fee paid").toEqual(["AWAITING_PAYMENT"]);
      const [audit] = await db()<{ v: { problem: string } }[]>`select new_value as v from audit_logs where action = 'dealer.territory_fee_paid' and entity_id = ${t3.id}`;
      expect(audit?.v.problem, "logged").toBe("amount_or_intent_mismatch");
      return `replay → one paid fee, same date; capture for ₹40,000 → nothing paid; fee/intent mismatch → audit amount_or_intent_mismatch; note: ${notes.join("; ")}`;
    } finally {
      await cancelAll();
    }
  });
}, local);

qa("TC-TERR-012", "an admin records a fee paid by bank transfer: reference 'AB' refused; 'UTR TEST 0001' → Active for 12 months, fee PAID (OFFLINE) with the reference, logged; an operator is refused (403)", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr012");
    try {
      const t = await give(d.dealerId, [await emptyPincode()]);
      const short = await territoryAction({ action: "recordPayment", territoryId: t.id, reference: "AB" });
      expectStatus(short, 422, "reference AB");
      expect(short.body.error.message).toBe("Give the payment reference (UTR, cheque number…).");
      const ops = await territoryAction({ action: "recordPayment", territoryId: t.id, reference: "UTR OPS 0001" }, "ops");
      expectStatus(ops, 403, "an operator records a payment");
      const admin = await pageAs(browser, "admin");
      try {
        await admin.page.goto("/admin/dealers/territories");
        const card = admin.page.getByTestId("territory-card").filter({ hasText: t.name });
        const field = card.getByLabel("Record a fee paid offline");
        await field.fill("AB");
        await expect(card.getByRole("button", { name: "Record payment" }), "too short to send").toBeDisabled();
        await field.fill("UTR TEST 0001");
        const before = Date.now();
        await card.getByRole("button", { name: "Record payment" }).click();
        await expect(admin.page.getByRole("status").filter({ hasText: "Fee recorded; the territory is paid up." })).toBeVisible();
        await expect(card).toContainText("Active");
        const row = await territoryRow(t.id);
        const [fee] = await feeRows(t.id);
        expect(fee).toMatchObject({ status: "PAID", method: "OFFLINE", reference: "UTR TEST 0001" });
        expect(Math.abs(addMonths(need(fee.period_start, "start"), 12).getTime() - need(row.paid_until, "paid up").getTime())).toBe(0);
        expect(need(fee.period_start, "start").getTime()).toBeGreaterThanOrEqual(before - 5_000);
        await card.getByText("Fees (1)").click();
        await expect(card).toContainText("paid offline (UTR TEST 0001)");
      } finally {
        await admin.context.close();
      }
      const [audit] = await db()<{ v: { method: string; reference: string } }[]>`select new_value as v from audit_logs where action = 'dealer.territory_fee_paid' and entity_id = ${t.id}`;
      expect(audit?.v).toMatchObject({ method: "OFFLINE", reference: "UTR TEST 0001" });
      return `AB refused (and the button stays disabled); UTR TEST 0001 → Active 12 months, PAID OFFLINE, logged; operator 403 "${ops.body.error.message}"`;
    } finally {
      await cancelAll();
    }
  });
}, local);

qa("TC-TERR-013", "renewal: refused (409) with 31+ days left; 30 days before the paid-up date one reminder and 'Pay ₹50,000 to renew' ('Covers 12 months from the paid-up date'); paid, the new date is the old one + 12 months", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr013");
    try {
      const t = await give(d.dealerId, [await emptyPincode()]);
      await payOffline(t.id);
      const early = await call(await ctxFor(d.owner), "POST", "/api/dealer/territory", { territoryId: t.id });
      expectStatus(early, 409, "a renewal 12 months early");
      expect(early.body.error.message).toBe("The renewal can be paid from 30 days before the paid-up date.");
      const { page, close } = await dealerPage(browser, d.owner, d.name);
      try {
        await expect(territoryCard(page).getByRole("button", { name: /^Pay ₹/ })).toHaveCount(0);
      } finally {
        await close();
      }
      const due = new Date(Date.now() + 29 * DAY);
      await movePaidUntil(t.id, due);
      const job = await territoryDaily();
      expect(Number(job.reminded), "renewals reminded").toBeGreaterThanOrEqual(1);
      await territoryDaily();
      const reminders = (await notesOf(await ctxFor(d.owner))).filter((x) => x.title === `Your territory ${t.name}: renewal due`);
      expect(reminders.length, "one reminder, not one a day").toBe(1);
      const issues: string[] = [];
      const second = await dealerPage(browser, d.owner, d.name);
      try {
        const card = territoryCard(second.page);
        await expect(card).toContainText("Paid up to");
        const renew = card.getByRole("button", { name: "Pay ₹50,000 to renew" });
        if (await renew.isVisible()) {
          await expect(card).toContainText("Covers 12 months from the paid-up date");
          await renew.click();
          await feeOnSandbox(second.page, "pay");
        } else {
          issues.push(`29 days before the paid-up date /dealer shows no 'Pay ₹50,000 to renew' (card: "${(await card.innerText()).replace(/\s+/g, " ").slice(-260)}")`);
          // The renewal paid through the same API the button calls, to check the new date.
          const started = await startPayment(d.owner, t.id);
          await feeOnSandbox(second.page, "pay", started.checkoutUrl);
        }
      } finally {
        await second.close();
      }
      const after = await territoryRow(t.id);
      expect(after.paid_until?.getTime(), "old paid-up date + 12 months").toBe(addMonths(due, 12).getTime());
      expect(issues, "the renewal on /dealer").toEqual([]);
      return `409 with 12 months left; 29 days before: 1 reminder, 'Pay ₹50,000 to renew'; paid → ${after.paid_until?.toISOString().slice(0, 10)} (= ${due.toISOString().slice(0, 10)} + 12 months)`;
    } finally {
      await cancelAll();
    }
  });
}, { ...local, timeout: 420_000 });

qa("TC-TERR-014", "fee not renewed: the daily job makes it 'Expired — fee not renewed', the dealer is told he earns nothing until paid, the pincodes stay his; an order delivered meanwhile does not count; paid within 30 days it is Active again and only orders delivered while paid up count", async ({ browser }) => {
  return territorial(() =>
    withCommission([shopA()], 200, async () => {
      const d = await dealer("terr014");
      try {
        const t = await give(d.dealerId, [TEST_PIN]);
        await payOffline(t.id);
        await movePaidUntil(t.id, new Date(Date.now() - DAY));
        const job = await territoryDaily();
        expect(Number(job.expired), "expired by the job").toBeGreaterThanOrEqual(1);
        expect((await territoryRow(t.id)).status).toBe("EXPIRED");
        expect(await heldPins(t.id), "the pincodes stay his").toEqual([TEST_PIN]);
        const note = (await notesOf(await ctxFor(d.owner))).find((x) => x.title === `Your territory ${t.name}: fee due — expired`);
        expect(note?.body).toBe(`The yearly fee for ${t.name} was not renewed, so you earn nothing on its orders until it is paid. Its pincodes stay yours for 30 more days; after that another dealer may take them.`);
        const { page, close } = await dealerPage(browser, d.owner, d.name);
        try {
          const card = territoryCard(page);
          await expect(card).toContainText("Expired — fee not renewed");
          await expect(card.getByRole("button", { name: "Pay ₹50,000 now" })).toBeVisible();
        } finally {
          await close();
        }
        const ctx = await ctxFor(d.owner);
        const lapsed = await delivered();
        expect((await myTerritory(ctx, t.id)).monthSoFar.orders, "the order delivered while lapsed does not count").toBe(0);
        await payOffline(t.id, `QA-RENEW-${RUN}`);
        expect((await territoryRow(t.id)).status).toBe("ACTIVE");
        const paidUp = await delivered();
        const view = await myTerritory(ctx, t.id);
        expect(view.monthSoFar.orders, "only the order delivered while paid up").toBe(1);
        expect(view.monthSoFar.commissionKeptPaise).toBe(paidUp.commission_paise);
        return `Expired by the daily job, told, 411038 kept; ${lapsed.order_number} (lapsed) not counted; paid again → Active, ${paidUp.order_number} counted`;
      } finally {
        await cancelAll();
      }
    }),
  );
}, { ...local, timeout: 420_000 });

qa("TC-TERR-015", "30+ days after the paid-up date the pincodes are released (dealer told); the card shows 'Pincodes: released'; paying and recording the fee are refused; another dealer can take the pincodes", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr015");
    const d2 = await dealer("terr015b");
    try {
      const pin = await emptyPincode();
      const t = await give(d.dealerId, [pin]);
      await payOffline(t.id);
      await movePaidUntil(t.id, new Date(Date.now() - 31 * DAY));
      const job = await territoryDaily();
      expect(Number(job.released), "released by the job").toBeGreaterThanOrEqual(1);
      expect(await heldPins(t.id)).toEqual([]);
      const note = (await notesOf(await ctxFor(d.owner))).find((x) => x.title === `Your territory ${t.name}: pincodes released`);
      expect(note?.body).toBe(`The fee for ${t.name} was not paid within 30 days, so its pincodes are released. Ask GoKesari if you want the territory again.`);
      const { page, close } = await dealerPage(browser, d.owner, d.name);
      try {
        const card = territoryCard(page);
        await expect(card).toContainText("Pincodes: released");
        await expect(card.getByRole("button", { name: /^Pay ₹/ })).toHaveCount(0);
      } finally {
        await close();
      }
      const pay = await call(await ctxFor(d.owner), "POST", "/api/dealer/territory", { territoryId: t.id });
      expectStatus(pay, 409, "the dealer pays after the release");
      expect(pay.body.error.message).toBe("This territory's pincodes were released after the grace period; ask GoKesari to give it again.");
      const record = await territoryAction({ action: "recordPayment", territoryId: t.id, reference: "QA-LATE-0001" });
      expectStatus(record, 409, "the admin records the fee after the release");
      expect(record.body.error.message).toBe("This fee could not be recorded: the territory's pincodes were released after the grace period. Give the territory again instead.");
      expect((await feeRows(t.id)).filter((f) => f.status === "PAID").length, "no new paid fee").toBe(1);
      const again = await give(d2.dealerId, [pin]);
      expect(await heldPins(again.id)).toEqual([pin]);
      return "released by the daily job, dealer told; card 'Pincodes: released' without Pay; pay and record 409; D2 takes the pincode";
    } finally {
      await cancelAll();
    }
  });
}, local);

/* ------------------------------------------------------ TS-TERR-03: the rating */

qa("TC-TERR-016", "share by rating 5 … 10 = 20 … 25% (+1% a point, never below 20% or above 25%): on a ₹1,000 order with ₹20 commission the dealer earns ₹4.00 … ₹5.00", async ({ browser }) => {
  return territorial(
    () =>
      withCommission([shopA()], 200, async () => {
        const d = await dealer("terr016");
        try {
          const t = await give(d.dealerId, [TEST_PIN]);
          await payOffline(t.id);
          const order = await delivered();
          expect([order.goods_paise, order.commission_paise], "a ₹1,000 order with 2% = ₹20").toEqual([100_000, 2_000]);
          const ctx = await ctxFor(d.owner);
          const seen: string[] = [];
          for (const [rating, share, income] of [
            [3, 2000, 400],
            [5, 2000, 400],
            [6, 2100, 420],
            [7, 2200, 440],
            [8, 2300, 460],
            [9, 2400, 480],
            [10, 2500, 500],
          ]) {
            await db()`update dealers set rating = ${rating} where id = ${d.dealerId}`;
            const rated = await territoryAction({ action: "rate", territoryId: t.id });
            expectStatus(rated, 200, "Rate now");
            expect(rated.body, `dealer rating ${rating}`).toEqual({ rating: Math.max(5, rating), shareBp: share });
            const v = await myTerritory(ctx, t.id);
            expect(v.monthSoFar, `rating ${rating}`).toEqual({ orders: 1, commissionKeptPaise: 2_000, incomePaise: income });
            seen.push(`${Math.max(5, rating)}→${share / 100}% ${rs(income)}`);
          }
          const { page, close } = await dealerPage(browser, d.owner, d.name);
          try {
            const card = territoryCard(page);
            await expect(card).toContainText("Rating 10.0 → you get 25% of GoKesari's commission");
            await expect(card).toContainText("This month so far: 1 orders · ₹20 GoKesari commission · ₹5 for you");
          } finally {
            await close();
          }
          return seen.join(", ");
        } finally {
          await cancelAll();
        }
      }),
    { productWeightBp: 0 },
  );
}, { ...local, partial: "productWeightBp is set to 0 for the check so the dealer's own rating alone sets the territory rating 5 … 10 (the rating's two halves: TC-TERR-017 / 018)" });

qa("TC-TERR-017", "worked example: dealer rating 9, 3 of 4 approved shops with 10+ active products → onboarding 2.0, product 1.9, rating 8.9, share 23.9% on the admin card and the dealer's card", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr017");
    try {
      const pin = await puneEmptyPincode();
      const shops: string[] = [];
      for (let i = 0; i < 4; i++) shops.push((await approvedShopOfNewOwner(`terr017-${i}`, { pincode: pin })).shop.id);
      const [{ n: inPin }] = await db()<{ n: number }[]>`select count(*)::int as n from shops where pincode = ${pin} and status = 'APPROVED'`;
      expect(inPin, `4 approved shops in ${pin}`).toBe(4);
      const products = await db()<{ id: string }[]>`select id from products where is_active order by created_at limit 10`;
      expect(products.length).toBe(10);
      for (const shopId of shops.slice(0, 3)) {
        await db()`insert into shop_products (shop_id, product_id) select ${shopId}, unnest(${products.map((p) => p.id)}::uuid[]) on conflict do nothing`;
      }
      await db()`update dealers set rating = 9 where id = ${d.dealerId}`;
      const t = await give(d.dealerId, [pin], { name: `QA Worked Example ${RUN}` });
      await payOffline(t.id);
      const admin = await pageAs(browser, "admin");
      try {
        await admin.page.goto("/admin/dealers/territories");
        const card = admin.page.getByTestId("territory-card").filter({ hasText: t.name });
        await card.getByRole("button", { name: "Rate now" }).click();
        await expect(admin.page.getByRole("status").filter({ hasText: "Rating worked out again." })).toBeVisible();
        await expect(card).toContainText("Rating: 8.9 → share 23.9% (onboarding +2, product upload +1.9: 3 of 4 shops live)");
      } finally {
        await admin.context.close();
      }
      const { page, close } = await dealerPage(browser, d.owner, d.name);
      try {
        await expect(territoryCard(page)).toContainText("Rating 8.9 → you get 23.9% of GoKesari's commission · 3 of 4 shops in your territory have products live");
      } finally {
        await close();
      }
      return `${pin}: 4 shops, 3 live, dealer 9 → 8.9 / 23.9% on both cards`;
    } finally {
      await cancelAll();
    }
  });
}, { ...local, partial: "the 10 active products of each live shop are arranged in the database" });

qa("TC-TERR-018", "rating edges: no approved shops → product points 0; dealer rating below 5 → onboarding points 0; a shop counts as live at 10 active products, not 9; a territory never rated shows the base 20%", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr018");
    const fresh = await dealer("terr018b");
    try {
      const empty = await give(d.dealerId, [await emptyPincode()]);
      await db()`update dealers set rating = 3 where id = ${d.dealerId}`;
      const r1 = await territoryAction({ action: "rate", territoryId: empty.id });
      expectStatus(r1, 200, "rate a territory with no shops");
      expect(r1.body).toEqual({ rating: 5, shareBp: 2000 });
      const [row1] = await db()<{ shops_total: number; product_points: string; onboarding_points: string }[]>`select shops_total, product_points, onboarding_points from dealer_territory_ratings where territory_id = ${empty.id}`;
      expect([row1.shops_total, Number(row1.product_points), Number(row1.onboarding_points)], "no shops: 0 product points; rating 3: 0 onboarding points").toEqual([0, 0, 0]);
      const pin = await puneEmptyPincode();
      const shop = (await approvedShopOfNewOwner("terr018-shop", { pincode: pin })).shop.id;
      const products = await db()<{ id: string }[]>`select id from products where is_active order by created_at limit 10`;
      await db()`insert into shop_products (shop_id, product_id) select ${shop}, unnest(${products.slice(0, 9).map((p) => p.id)}::uuid[]) on conflict do nothing`;
      const t = await give(d.dealerId, [pin]);
      await db()`update dealers set rating = 5 where id = ${d.dealerId}`;
      const nine = await territoryAction({ action: "rate", territoryId: t.id });
      expect(nine.body, "9 products: not live").toEqual({ rating: 5, shareBp: 2000 });
      await db()`insert into shop_products (shop_id, product_id) values (${shop}, ${products[9].id}) on conflict do nothing`;
      const ten = await territoryAction({ action: "rate", territoryId: t.id });
      expect(ten.body, "10 products: live → +2.5").toEqual({ rating: 7.5, shareBp: 2250 });
      const never = await give(fresh.dealerId, [await emptyPincode()]);
      const view = await myTerritory(await ctxFor(fresh.owner), never.id);
      expect([view.rating, view.shareBp, view.latestRating], "never rated: base").toEqual([5, 2000, null]);
      const { page, close } = await dealerPage(browser, fresh.owner, fresh.name);
      try {
        await expect(territoryCard(page)).toContainText("Rating 5.0 → you get 20% of GoKesari's commission");
      } finally {
        await close();
      }
      return "no shops 0 points; rating 3 → 0 onboarding points (5.0, 20%); 9 products not live, 10 live (7.5, 22.5%); never rated: 5.0 / 20%";
    } finally {
      await cancelAll();
    }
  });
}, { ...local, partial: "an order delivered before the first rating earning the base 20% is shown in TC-TERR-020 (an unrated territory)" });

qa("TC-TERR-019", "the daily job rates every active territory once a day (Rate now re-works today's row, no second row); each order's share uses the rating of its delivery day", async () => {
  return territorial(
    () =>
      withCommission([shopA()], 200, async () => {
        const d = await dealer("terr019");
        try {
          const t = await give(d.dealerId, [TEST_PIN]);
          await payOffline(t.id);
          await db()`update dealers set rating = 6 where id = ${d.dealerId}`;
          const job = await territoryDaily();
          expect(Number(job.rated), "the job rated the active territories").toBeGreaterThanOrEqual(1);
          const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
          const rows = async () => db()<{ day: string; share_bp: number }[]>`select to_char(day, 'YYYY-MM-DD') as day, share_bp from dealer_territory_ratings where territory_id = ${t.id} order by day`;
          expect(await rows(), "one row for today").toEqual([{ day: today, share_bp: 2100 }]);
          await db()`update dealers set rating = 8 where id = ${d.dealerId}`;
          expectStatus(await territoryAction({ action: "rate", territoryId: t.id }), 200, "Rate now");
          expect(await rows(), "Rate now re-works today's row").toEqual([{ day: today, share_bp: 2300 }]);
          // Two days of one month, each with the rating the job wrote that morning, and an order delivered on each.
          const month = await freeMonth();
          const [day1, day2] = [`${month}-10`, `${month}-20`];
          for (const [day, rating, share] of [[day1, 6, 2100], [day2, 9, 2400]] as const) {
            await db()`insert into dealer_territory_ratings (territory_id, day, onboarding_rating, shops_total, shops_live, onboarding_points, product_points, rating, share_bp)
                       values (${t.id}, ${day}, ${rating}, 0, 0, ${rating - 5}, 0, ${rating}, ${share})`;
          }
          const o1 = await delivered();
          const o2 = await delivered();
          await backdate(t.id, [o1.order_id], new Date(`${day1}T06:30:00Z`));
          await backdate(t.id, [o2.order_id], new Date(`${day2}T06:30:00Z`));
          await closeMonth(month);
          const shares = await db()<{ order_id: string; share_bp: number; amount_paise: number }[]>`
            select order_id, share_bp, amount_paise from dealer_territory_order_shares where order_id in ${db()([o1.order_id, o2.order_id])}`;
          const of = (id: string) => need(shares.find((x) => x.order_id === id), `the share of order ${id}`);
          expect([of(o1.order_id).share_bp, of(o1.order_id).amount_paise], `the order of ${day1} at that day's 21%`).toEqual([2100, shareOf(o1.commission_paise, 2100)]);
          expect([of(o2.order_id).share_bp, of(o2.order_id).amount_paise], `the order of ${day2} at that day's 24%`).toEqual([2400, shareOf(o2.commission_paise, 2400)]);
          return `job: one row for ${today} (21%); Rate now → same row 23%; ${month}: ${o1.order_number} (${day1}) at 21%, ${o2.order_number} (${day2}) at 24%`;
        } finally {
          await cancelAll();
        }
      }),
    { productWeightBp: 0 },
  );
}, { ...local, timeout: 420_000, partial: "the two days' rating rows of an earlier month are arranged in the database (the job runs with today's clock) and that month is closed to read each order's share; productWeightBp 0 so the dealer's rating sets the share" });

/* ------------------------------------------------- TS-TERR-04: order income */

qa("TC-TERR-020", "counted: delivered orders of every approved shop in the pincodes (incl. one another dealer signed, one registered earlier); not counted: a cancelled and an undelivered order, shops outside; the card shows orders, commission and 'for you'", async ({ browser }) => {
  return territorial(() =>
    withCommission([shopA(), shopB()], 200, async () => {
      const d = await dealer("terr020");
      const other = await dealer("terr020b");
      const [before] = await db()<{ dealer_id: string; salesperson_id: string | null; source: string; match_kind: string }[]>`select dealer_id, salesperson_id, source, match_kind from shop_attributions where shop_id = ${shopB()}`;
      let undelivered: string | null = null;
      try {
        const t = await give(d.dealerId, [TEST_PIN], { name: `QA Counted ${RUN}` });
        await payOffline(t.id);
        const outside = await give(d.dealerId, [await emptyPincode()], { name: `QA Outside ${RUN}` });
        await payOffline(outside.id);
        // Shop B was signed by another dealer.
        await db()`insert into shop_attributions (shop_id, dealer_id, salesperson_id, source, match_kind) values (${shopB()}, ${other.dealerId}, null, 'CODE_AT_REGISTRATION', 'NONE')
          on conflict (shop_id) do update set dealer_id = excluded.dealer_id, salesperson_id = null, source = excluded.source, match_kind = excluded.match_kind`;
        const [{ earlier }] = await db()<{ earlier: boolean }[]>`select (select created_at from shops where id = ${shopA()}) < (select created_at from dealer_exclusive_territories where id = ${t.id}) as earlier`;
        expect(earlier, "shop A was registered before the territory was given").toBe(true);
        const a = await delivered();
        const b = await delivered({ listing: await listingOf("sharedB"), quantity: 4 });
        const cancelled = await placeSimple();
        expectStatus(await call(await as("customer"), "PATCH", `/api/orders/${cancelled.id}/status`, { status: "CANCELLED", note: "QA cancel" }), 200, "cancel an order");
        undelivered = (await placeSimple()).id;
        const ctx = await ctxFor(d.owner);
        const v = await myTerritory(ctx, t.id);
        const kept = a.commission_paise + b.commission_paise;
        const income = shareOf(a.commission_paise, 2000) + shareOf(b.commission_paise, 2000);
        expect(v.monthSoFar, "shop A's and shop B's delivered orders, at the base 20% (never rated)").toEqual({ orders: 2, commissionKeptPaise: kept, incomePaise: income });
        expect((await myTerritory(ctx, outside.id)).monthSoFar.orders, "a territory without those shops counts none").toBe(0);
        const { page, close } = await dealerPage(browser, d.owner, d.name);
        try {
          await expect(territoryCard(page)).toContainText(`This month so far: 2 orders · ${rs(kept)} GoKesari commission · ${rs(income)} for you`);
        } finally {
          await close();
        }
        return `${a.order_number} (A) + ${b.order_number} (B, signed by another dealer) counted: ${rs(kept)} → ${rs(income)}; cancelled and undelivered not; the other territory 0`;
      } finally {
        await abandon(undelivered);
        if (before) {
          await db()`update shop_attributions set dealer_id = ${before.dealer_id}, salesperson_id = ${before.salesperson_id}, source = ${before.source}, match_kind = ${before.match_kind} where shop_id = ${shopB()}`;
        } else {
          await db()`delete from shop_attributions where shop_id = ${shopB()}`;
        }
        await cancelAll();
      }
    }),
  );
}, { ...local, timeout: 420_000 });

qa("TC-TERR-021", "a ₹200 goods refund on a ₹1,000 order (₹20 commission) leaves ₹16 kept; the dealer's share at 20% is ₹3.20, not ₹4.00", async ({ browser }) => {
  return territorial(() =>
    withCommission([shopA()], 200, async () => {
      const d = await dealer("terr021");
      try {
        const t = await give(d.dealerId, [TEST_PIN]);
        await payOffline(t.id);
        const order = await delivered();
        expect([order.goods_paise, order.commission_paise]).toEqual([100_000, 2_000]);
        await refundGoods(order.order_number, 20_000);
        const v = await myTerritory(await ctxFor(d.owner), t.id);
        expect(v.monthSoFar, "₹20 − ₹4 = ₹16 kept; 20% = ₹3.20").toEqual({ orders: 1, commissionKeptPaise: 1_600, incomePaise: 320 });
        const { page, close } = await dealerPage(browser, d.owner, d.name);
        try {
          await expect(territoryCard(page)).toContainText("This month so far: 1 orders · ₹16 GoKesari commission · ₹3.2 for you");
        } finally {
          await close();
        }
        return `${order.order_number}: ₹200 refunded → ₹16 kept, ₹3.20 for the dealer`;
      } finally {
        await cancelAll();
      }
    }),
  );
}, local);

const CLOSE_KEY = "dealer-territory-2026-11:month-close";

interface Closed {
  dealerId: string;
  owner: Account;
  orderNumber: string;
  orderId: string;
  commission: number;
  amount: number;
  month: string;
  entryId: string;
}

qa("TC-TERR-022", "month close: one TERRITORY entry for the territory and month = the sum of its order shares, in the dealer's one payout with the line 'Territory order income'; another admin approves it, then it is paid", async () => {
  return territorial(() =>
    withCommission([shopA()], 200, async () => {
      const d = await dealer("terr022");
      try {
        const t = await give(d.dealerId, [TEST_PIN]);
        await payOffline(t.id);
        const o1 = await delivered();
        const o2 = await delivered({ quantity: 10 });
        const month = await freeMonth();
        await backdate(t.id, [o1.order_id, o2.order_id], midMonth(month));
        await closeMonth(month);
        const expected = shareOf(o1.commission_paise, 2000) + shareOf(o2.commission_paise, 2000);
        const entries = await territoryEntries(d.dealerId);
        expect(entries.map((e) => [e.kind, e.amount_paise, e.payee_member_id, e.accrual_key]), "one TERRITORY entry").toEqual([["ACCRUAL", expected, null, `TO:${t.id}:${month}`]]);
        const entry = entries[0];
        const shares = await db()<{ order_id: string; month: string; amount_paise: number; ledger_entry_id: string }[]>`select order_id, month, amount_paise, ledger_entry_id from dealer_territory_order_shares where territory_id = ${t.id} order by order_id`;
        expect(shares.length, "both orders worked out").toBe(2);
        expect(shares.every((s) => s.month === month && s.ledger_entry_id === entry.id)).toBe(true);
        const batchId = need(entry.payout_batch_id, "the entry in the month's draft payout");
        const [batch] = await db()<{ status: string; period_month: string; member_id: string | null; total_paise: number }[]>`select status, period_month, member_id, total_paise::int as total_paise from dealer_payout_batches where id = ${batchId}`;
        expect(batch).toEqual({ status: "DRAFT", period_month: month, member_id: null, total_paise: expected });
        const csv = await call(await ctxFor(d.owner), "GET", `/api/dealer/commission/statement?month=${month}`);
        expectStatus(csv, 200, "the dealer's statement");
        expect(csv.text, "the statement line").toContain(`"  Territory order income (Rs)","${(expected / 100).toFixed(2)}"`);
        const self = await commissionAction({ action: "approvePayout", batchId });
        expectStatus(self, 409, "the drafting admin approves");
        expect(self.body.error.message).toBe("The admin who drafted this payout cannot approve it — another admin approves (maker-checker).");
        const second = await ctxFor(await freshAccount("terr022-admin2", "ADMIN"));
        const approved = await call(second, "POST", "/api/admin/dealer-commission", { action: "approvePayout", batchId });
        if (approved.status === 409 && approved.body?.error?.details?.reason === "TDS_UNCONFIRMED") need(null, "a CA-confirmed TDS row (Admin → TDS on commission)");
        expectStatus(approved, 200, "another admin approves");
        const paid = await commissionAction({ action: "payoutPaid", batchId, reference: `QA-TERR-UTR-${RUN}` });
        expectStatus(paid, 200, "paid");
        const [after] = await db()<{ status: string }[]>`select status from dealer_commission_ledger where id = ${entry.id}`;
        expect(after.status).toBe("PAID");
        stash<Closed>(CLOSE_KEY, { dealerId: d.dealerId, owner: d.owner, orderNumber: o1.order_number, orderId: o1.order_id, commission: o1.commission_paise, amount: shareOf(o1.commission_paise, 2000), month, entryId: entry.id });
        return `${month}: TERRITORY ${rs(expected)} (2 orders) in the dealer's payout; statement line 'Territory order income'; drafter refused, second admin approved; PAID`;
      } finally {
        await cancelAll();
      }
    }),
  );
}, { ...local, timeout: 420_000, partial: "the orders are delivered today and their delivery moved into an old month that is then closed with 'Close <month> now' (the payout-day job closes only last month)" });

qa("TC-TERR-023", "a goods refund recorded after the month closed: a TERRITORY REVERSAL at the next close reduces the next payout; last month's entry is unchanged", async () => {
  const c = unstash<Closed>(CLOSE_KEY);
  if (!c) blocked("needs the month closed by TC-TERR-022 of this run");
  return territorial(async () => {
    await refundGoods(c.orderNumber, 20_000);
    const next = nextMonth(c.month);
    const closed = await closeMonth(next);
    const entries = await territoryEntries(c.dealerId);
    const reversal = need(entries.find((e) => e.kind === "REVERSAL"), "a REVERSAL entry");
    const [fin] = await db()<{ goods: number; rate_bp: number }[]>`select goods_paise::int as goods, commission_rate_bp as rate_bp from order_financials where order_id = ${c.orderId}`;
    const refundedCommission = Math.round((Math.min(20_000, fin.goods) * fin.rate_bp) / 10_000);
    const expected = shareOf(c.commission - refundedCommission, 2000) - c.amount;
    expect([reversal.entry_type, reversal.amount_paise, reversal.accrual_key?.startsWith("TR:"), reversal.status], "the correction").toEqual(["TERRITORY", expected, true, "EARNED"]);
    expect(reversal.note ?? "").toContain(`${next}: refunds recorded after an earlier close`);
    const original = need(entries.find((e) => e.id === c.entryId), "last month's entry");
    expect([original.kind, original.status], "last month's entry unchanged").toEqual(["ACCRUAL", "PAID"]);
    const carried = (closed.carried as { dealerId: string; memberId: string | null; netPaise: number; reason: string }[]).find((x) => x.dealerId === c.dealerId);
    expect(carried, "taken from the next payout (owed back while nothing else is due)").toMatchObject({ memberId: null, netPaise: expected, reason: "owed back" });
    return `refund after ${c.month} closed → ${next}: REVERSAL ${rs(expected)}, carried as owed back; ${c.month}'s entry still PAID`;
  });
}, local);

qa("TC-TERR-024", "a territory dealer's team keeps the 20 / 4 / 3 % registration commission on a shop in the territory; the order income is the main dealer's alone", async () => {
  return territorial(() =>
    withCommission([shopA()], 200, async () => {
      const net = await tieredNetwork("terr024");
      try {
        const t = await give(net.dealerId, [TEST_PIN]);
        await payOffline(t.id);
        const shop = await activatedShop(net.dealerId, net.agent.id);
        const [{ pincode }] = await db()<{ pincode: string }[]>`select pincode from shops where id = ${shop.shopId}`;
        expect(pincode, "the agent's shop is in the territory").toBe(TEST_PIN);
        expect(await accruals(shop.shopId), "20 / 4 / 3 % unchanged").toEqual([
          ["DIRECT_1", net.agent.id, 99_980],
          ["OVERRIDE_LEAD", net.lead.id, 19_996],
          ["OVERRIDE_MAIN", null, 14_997],
        ]);
        const order = await delivered();
        const month = await freeMonth();
        await backdate(t.id, [order.order_id], midMonth(month));
        await closeMonth(month);
        const entries = await territoryEntries(net.dealerId);
        expect(entries.map((e) => [e.kind, e.payee_member_id, e.amount_paise]), "order income: the main dealer only").toEqual([["ACCRUAL", null, shareOf(order.commission_paise, 2000)]]);
        const members = await db()`select 1 from dealer_commission_ledger where entry_type = 'TERRITORY' and payee_member_id in ${db()([net.lead.id, net.agent.id])}`;
        expect(members.length, "nothing to the lead or the agent").toBe(0);
        return `registration 999.80 / 199.96 / 149.97; ${month} order income ${rs(entries[0].amount_paise)} to the main dealer only`;
      } finally {
        await cancelAll();
      }
    }),
  );
}, { ...local, timeout: 420_000, partial: "the order comes from shop A of the same territory, not from the agent's new shop (a new shop has no catalogue to order from)" });

/* ------------------------------------------------ TS-TERR-05: access, the card */

qa("TC-TERR-025", "who may read and change territories: admin and operator read (200), customer and shop owner 403, guest 401; an operator's changes 403; a dealer sees only his own and cannot pay another's (404 'Territory')", async () => {
  return territorial(async () => {
    const d1 = await dealer("terr025a");
    const d2 = await dealer("terr025b");
    try {
      const t1 = await give(d1.dealerId, [await emptyPincode()]);
      const t2 = await give(d2.dealerId, [await emptyPincode()]);
      const reads: string[] = [];
      for (const [role, status] of [["admin", 200], ["ops", 200], ["customer", 403], ["shop", 403]] as const) {
        const res = await call(await as(role), "GET", "/api/admin/dealer-territories");
        expectStatus(res, status, `GET as ${role}`);
        reads.push(`${role} ${res.status}`);
      }
      const guest = await anonymous();
      try {
        const res = await call(guest, "GET", "/api/admin/dealer-territories");
        expectStatus(res, 401, "GET as a guest");
      } finally {
        await guest.dispose();
      }
      const messages = new Set<string>();
      for (const body of [
        { action: "create", dealerId: d1.dealerId, name: "QA Ops", pincodes: [await emptyPincode()], feePaise: 5_000_000 },
        { action: "pincodes", territoryId: t1.id, add: [await emptyPincode()], remove: [], reason: "QA: operator" },
        { action: "fee", territoryId: t1.id, feePaise: 6_000_000, reason: "QA: operator" },
        { action: "cancel", territoryId: t1.id, reason: "QA: operator" },
      ]) {
        const res = await territoryAction(body, "ops");
        expectStatus(res, 403, `operator ${body.action}`);
        messages.add(res.body.error.message);
      }
      expect((await territoryRow(t1.id)).status, "nothing changed").toBe("AWAITING_FEE");
      const mine = await myTerritories(await ctxFor(d1.owner));
      expect(mine.map((t) => t.id), "D1 sees only his own").toEqual([t1.id]);
      const theirs = await call(await ctxFor(d1.owner), "POST", "/api/dealer/territory", { territoryId: t2.id });
      expectStatus(theirs, 404, "D1 pays D2's territory");
      expect(theirs.body.error.message).toBe("Territory was not found.");
      return `${reads.join(", ")}, guest 401; operator create/pincodes/fee/cancel 403 ("${[...messages].join('" / "')}"); D1 sees 1, D2's → 404`;
    } finally {
      await cancelAll();
    }
  });
}, local);

qa("TC-TERR-026", "the 'Your territory' card on /dealer (desktop and phone): explanation, name and status, pincodes, paid up and fee, rating and share, this month so far, Pay only when payable; no sideways scroll; a dealer with no territory sees no card", async ({ browser }) => {
  return territorial(async () => {
    const d = await dealer("terr026");
    const none = await dealer("terr026b");
    try {
      const pin = await emptyPincode();
      const t = await give(d.dealerId, [pin], { name: `QA Card ${RUN}` });
      const row = await payOffline(t.id);
      const { page, close } = await dealerPage(browser, d.owner, d.name);
      try {
        const card = territoryCard(page);
        await expect(card.getByRole("heading", { name: "Your territory" })).toBeVisible();
        await expect(card).toContainText("plus 20% of GoKesari's commission on every order delivered by a shop in your territory — up to 25% as your rating goes up (+1% a point)");
        await expect(card).toContainText("at least 10 products live");
        await expect(card.getByRole("heading", { name: t.name })).toBeVisible();
        await expect(card).toContainText("Active");
        await expect(card).toContainText(`Pincodes: ${pin}`);
        await expect(card).toContainText(`Paid up to ${lastDay(need(row.paid_until, "paid up"))} · yearly fee ₹50,000`);
        await expect(card).toContainText("Rating 5.0 → you get 20% of GoKesari's commission");
        await expect(card).toContainText("This month so far: 0 orders · ₹0 GoKesari commission · ₹0 for you");
        await expect(card.getByRole("button", { name: /^Pay ₹/ }), "not payable 12 months ahead").toHaveCount(0);
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(sideways, "no sideways scroll").toBeLessThanOrEqual(0);
      } finally {
        await close();
      }
      const other = await dealerPage(browser, none.owner, none.name);
      try {
        await expect(other.page.getByTestId("dealer-team")).toBeVisible();
        await expect(territoryCard(other.page)).toHaveCount(0);
      } finally {
        await other.close();
      }
      return "card with explanation, Active, pincode, paid up / ₹50,000, rating 5.0 → 20%, month so far, no Pay; no sideways scroll; no card without a territory";
    } finally {
      await cancelAll();
    }
  });
}, { ...local, mobile: true });
