/**
 * Customer referrals (QA package 1, Marketing & consent: TC-MKT-014..017 and
 * the sign-up referral field TC-FLD-132): a friend joins with a customer's
 * code and both are rewarded once after the first delivered order; abuse is
 * not rewarded; the reward cap; case-insensitive and unknown codes; and what
 * happens to a reward later found to be fraud.
 *
 * Local tier: rule `customerReferrals` (off by default) is switched on for
 * these checks and restored; new people sign up with emailed codes from the
 * local mail catcher; their mobile, address and wallet are arranged in the
 * local database; shop A packs and rider 1 delivers each first order.
 */
import type { APIRequestContext, Browser } from "@playwright/test";

import { as } from "../lib/actors";
import {
  addAddress,
  apiWithCookie,
  arrangeRider,
  browserWithCookie,
  deliverFor,
  fundWallet,
  guestContext,
  keep,
  kept,
  localUser,
  mintSession,
  releaseOffers,
  signInWithCode,
  uniqueEmail,
  uniqueMobile,
  walletOrder,
  withRule,
} from "../lib/auth-helpers";
import { db } from "../lib/db";
import { call, expectStatus } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 480_000 };
const REFERRALS = { enabled: true, referrerRewardPaise: 5000, refereeRewardPaise: 5000, maxRewardsPerReferrer: 20, applyWithinDays: 30 };
const REFERRER_TEXT = "Referral reward — your friend's first order was delivered";
const REFEREE_TEXT = "Welcome reward — referred by a friend";

interface Person {
  id: string;
  email: string;
  ctx: APIRequestContext;
  addressId: string | null;
}

async function codeOf(ctx: APIRequestContext) {
  const res = await call(ctx, "GET", "/api/customer-referrals");
  expectStatus(res, 200, "GET /api/customer-referrals");
  return res.body.code as string;
}

async function promoCredits(userId: string, text: string) {
  return db()<{ amount_paise: string }[]>`select amount_paise from wallet_transactions where user_id = ${userId} and type = 'PROMOTIONAL_CREDIT' and description = ${text}`;
}

/** Rider 1 alone online and free, so each first order goes to them. */
async function ridersReady() {
  await arrangeRider("rider2", { online: false });
  await arrangeRider("rider");
  await releaseOffers("rider");
}

/** What a new customer adds before a first order: a mobile, an address in shop A's zone and money in the wallet. */
async function readyToOrder(id: string, email: string): Promise<Person> {
  const mobile = uniqueMobile();
  await db()`update users set phone = ${mobile}, phone_e164 = ${`+91${mobile}`} where id = ${id}`;
  const addressId = await addAddress(id, `QA Referee flat ${Math.floor(Math.random() * 900 + 100)}`);
  await fundWallet(id, 200_000);
  return { id, email, ctx: await apiWithCookie(await mintSession(id, email)), addressId };
}

/** Signs a new person up on the site and enters `code` in the first-time details form. */
async function signUpWith(browser: Browser, code: string | null, label: string) {
  const email = uniqueEmail(label);
  const { context, page } = await guestContext(browser);
  try {
    await signInWithCode(page, email);
    const field = page.getByTestId("signup-referral-code");
    await expect(field, "the referral code field on first-time setup").toBeVisible();
    if (code !== null) await field.fill(code);
    await page.getByLabel("Full name").fill(`QA ${label}`);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByRole("heading", { name: "Delivery address" })).toBeVisible();
    const [row] = await db()<{ id: string }[]>`select id from users where email = ${email}`;
    return { id: row.id, email };
  } finally {
    await context.close();
  }
}

/** The person's first order from shop A, delivered by rider 1. */
async function firstOrderDelivered(person: Person) {
  const listing = need(world().listings.packaged, "shop A's packaged listing");
  const order = await walletOrder(person.ctx, listing.shopProductId, need(world().shops.A?.id, "shop A"), person.addressId);
  await deliverFor(order.id, person.ctx, { rider: "rider", mail: { email: person.email, orderNumber: order.orderNumber } });
  return order;
}

const REWARDED = "referral-rewarded";

qa("TC-MKT-014", "a new person joins with a customer's code; after their first order is delivered both get the reward once, shown in the wallet with the reason", async ({ browser }) => {
  return withRule("customerReferrals", REFERRALS, async () => {
    await ridersReady();
    const referrer = await localUser("referrer", { address: true });
    const code = await codeOf(referrer.ctx);
    const joined = await signUpWith(browser, code, "referee");
    const friend = await readyToOrder(joined.id, joined.email);
    const mine = (await call(friend.ctx, "GET", "/api/customer-referrals")).body;
    expect(mine.referredBy?.status, "the friend's referral is pending").toBe("PENDING");
    expect((await promoCredits(referrer.id, REFERRER_TEXT)).length, "no reward before delivery").toBe(0);
    const first = await firstOrderDelivered(friend);
    expect((await promoCredits(referrer.id, REFERRER_TEXT)).map((r) => Number(r.amount_paise)), "referrer rewarded once").toEqual([5000]);
    expect((await promoCredits(friend.id, REFEREE_TEXT)).map((r) => Number(r.amount_paise)), "friend rewarded once").toEqual([5000]);
    await firstOrderDelivered(friend);
    expect((await promoCredits(referrer.id, REFERRER_TEXT)).length, "not again for a second order").toBe(1);
    expect((await promoCredits(friend.id, REFEREE_TEXT)).length).toBe(1);
    const wallet = await call(friend.ctx, "GET", "/api/wallet");
    expect(JSON.stringify(wallet.body.transactions), "the reason in the wallet").toContain(REFEREE_TEXT);
    const { context, page } = await browserWithCookie(browser, referrer.cookie);
    try {
      await page.goto("/wallet");
      await expect(page.getByText(REFERRER_TEXT).first(), "the referrer's wallet page shows the reason").toBeVisible();
    } finally {
      await context.close();
    }
    const [referral] = await db()<{ id: string; status: string }[]>`select id, status from customer_referrals where referee_user_id = ${friend.id}`;
    expect(referral.status).toBe("REWARDED");
    keep(REWARDED, { referralId: referral.id, referrerId: referrer.id, refereeId: friend.id });
    return `code ${code} entered at sign-up → PENDING; ${first.orderNumber} delivered → ₹50 each ("${REFERRER_TEXT}" / "${REFEREE_TEXT}"); a second delivered order adds nothing`;
  });
}, local);

qa("TC-MKT-015", "referral abuse earns nothing: the own code, an existing customer, a friend ordering to the referrer's address, a first order cancelled", async () => {
  return withRule("customerReferrals", REFERRALS, async () => {
    await ridersReady();
    const referrer = await localUser("abuse-referrer", { address: true });
    const code = await codeOf(referrer.ctx);
    const out: string[] = [];
    for (const [path, body] of [["/api/customer-referrals", { code }], ["/api/me/signup-referral", { code }]] as const) {
      const own = await call(referrer.ctx, "POST", path, body);
      expect(own.status, `own code via ${path}`).toBe(422);
      out.push(`own code (${path}) → ${own.status} "${own.body.error.message}"`);
    }
    const existing = await call(await as("customer"), "POST", "/api/customer-referrals", { code });
    expect(existing.status, "an existing customer").toBeGreaterThanOrEqual(400);
    expect(existing.status).toBeLessThan(500);
    out.push(`existing customer → ${existing.status} "${existing.body.error.message}"`);
    // A "friend" whose order goes to the referrer's own address.
    const [home] = await db()<{ line1: string }[]>`select line1 from addresses where id = ${referrer.addressId!}`;
    const sameAddress = await localUser("same-address", { walletPaise: 200_000 });
    const addressId = await addAddress(sameAddress.id, home.line1);
    expectStatus(await call(sameAddress.ctx, "POST", "/api/customer-referrals", { code }), 201, "apply the code");
    await firstOrderDelivered({ id: sameAddress.id, email: sameAddress.email, ctx: sameAddress.ctx, addressId });
    const [sameRow] = await db()<{ status: string; rejection_reason: string | null }[]>`select status, rejection_reason from customer_referrals where referee_user_id = ${sameAddress.id}`;
    expect([sameRow.status, sameRow.rejection_reason]).toEqual(["REJECTED", "Delivered to the referrer's own address."]);
    out.push(`order to the referrer's address → REJECTED "${sameRow.rejection_reason}"`);
    // A friend whose first order is cancelled.
    const cancels = await localUser("cancels", { walletPaise: 200_000, address: true });
    expectStatus(await call(cancels.ctx, "POST", "/api/customer-referrals", { code }), 201, "apply the code");
    const listing = need(world().listings.packaged, "shop A's packaged listing");
    const order = await walletOrder(cancels.ctx, listing.shopProductId, need(world().shops.A?.id, "shop A"), cancels.addressId);
    expectStatus(await call(cancels.ctx, "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA" }), 200, "cancel the first order");
    const [cancelRow] = await db()<{ status: string }[]>`select status from customer_referrals where referee_user_id = ${cancels.id}`;
    expect(cancelRow.status, "no reward for a cancelled first order").toBe("PENDING");
    out.push("first order cancelled → still PENDING");
    for (const id of [referrer.id, sameAddress.id, cancels.id]) {
      const credits = await db()<{ n: number }[]>`select count(*)::int as n from wallet_transactions where user_id = ${id} and type = 'PROMOTIONAL_CREDIT'`;
      expect(credits[0].n, "no reward credited").toBe(0);
    }
    out.push("no promotional credit to anyone");
    return out.join("; ");
  });
}, { ...local, partial: "a new account on the referrer's own mobile cannot exist (mobile numbers are unique per account); the same device is not tracked; a delivered-then-refunded first order is TC-MKT-017's reversal; the risk flag is the next check" });

qa("TC-MKT-015", "repeated referral abuse raises a risk flag", async () => {
  return withRule("customerReferrals", REFERRALS, async () => {
    const referrer = await localUser("flagme");
    const code = await codeOf(referrer.ctx);
    for (let i = 0; i < 4; i++) await call(referrer.ctx, "POST", "/api/customer-referrals", { code });
    expectStatus(await call(await as("ops"), "POST", "/api/admin/risk"), 200, "operations runs the risk rules");
    const flags = await db()<{ rule_code: string }[]>`select rule_code from risk_flags where subject_id = ${referrer.id}`;
    const rules = await db()<{ rule_code: string }[]>`select distinct rule_code from risk_flags`;
    expect(flags.length, `no risk flag after 4 attempts to use the own code (flag types in use: ${rules.map((r) => r.rule_code).join(", ") || "none"}); the risk rules have no referral rule (src/server/services/risk.ts)`).toBeGreaterThan(0);
    return `flagged: ${flags.map((f) => f.rule_code).join(", ")}`;
  });
}, local);

qa("TC-MKT-016", "rewards stop at the referrer's cap; a code works in any case and with spaces; an unknown code gives a clear message", async () => {
  return withRule("customerReferrals", { ...REFERRALS, maxRewardsPerReferrer: 1 }, async () => {
    await ridersReady();
    const referrer = await localUser("capped", { address: true });
    const code = await codeOf(referrer.ctx);
    const friends: Person[] = [];
    for (const [i, entered] of [` ${code.toLowerCase().slice(0, 4)} ${code.toLowerCase().slice(4)} `, code.toLowerCase()].entries()) {
      const f = await localUser(`capped-friend-${i}`, { walletPaise: 200_000, address: true });
      const res = await call(f.ctx, "POST", "/api/me/signup-referral", { code: entered });
      expectStatus(res, 200, `code "${entered}"`);
      expect(res.body.kind).toBe("FRIEND");
      friends.push({ id: f.id, email: f.email, ctx: f.ctx, addressId: f.addressId });
    }
    for (const f of friends) await firstOrderDelivered(f);
    const toReferrer = await promoCredits(referrer.id, REFERRER_TEXT);
    expect(toReferrer.map((r) => Number(r.amount_paise)), "the referrer is rewarded up to the cap (1)").toEqual([5000]);
    for (const f of friends) expect((await promoCredits(f.id, REFEREE_TEXT)).length, "each friend still gets the welcome reward").toBe(1);
    const unknown = await localUser("unknown-code");
    const bad = await call(unknown.ctx, "POST", "/api/me/signup-referral", { code: "QAUNKNOWN9" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toBe("This referral code is not valid.");
    const carryOn = await call(unknown.ctx, "PATCH", "/api/profile", { name: "QA no code", markComplete: true });
    expectStatus(carryOn, 200, "sign-up continues without a code");
    return `"${code}" accepted as " ${code.toLowerCase().slice(0, 4)} ${code.toLowerCase().slice(4)} " and "${code.toLowerCase()}"; with the cap at 1 the referrer got one ₹50 reward, both friends theirs; an unknown code → 422 "${bad.body.error.message}", setup still completes`;
  });
}, { ...local, partial: "the cap is exercised at 1 (rule customerReferrals.maxRewardsPerReferrer lowered from its default 20)" });

qa("TC-MKT-017", "a rewarded referral later flagged as fraud: operations actions the flag, the reward is reversed with a ledger entry and the wallet never goes negative", async () => {
  const rewarded = kept<{ referralId: string; referrerId: string; refereeId: string }>(REWARDED) ?? blocked("needs the rewarded referral of TC-MKT-014");
  expectStatus(await call(await as("ops"), "POST", "/api/admin/risk"), 200, "operations runs the risk rules");
  const flags = await db()<{ id: string; rule_code: string }[]>`select id, rule_code from risk_flags where subject_id in (${rewarded.referrerId}, ${rewarded.refereeId})`;
  const reversals = await db()<{ n: number }[]>`select count(*)::int as n from wallet_transactions where user_id in (${rewarded.referrerId}, ${rewarded.refereeId}) and reversal_of_id is not null`;
  expect(
    flags.length,
    `referral ${rewarded.referralId} is REWARDED but no risk flag can be raised on it (risk rules have no referral rule — src/server/services/risk.ts) and nothing reverses a referral reward (src/server/services/customer-referrals.ts); reversal rows: ${reversals[0].n}`,
  ).toBeGreaterThan(0);
  return `flags: ${flags.map((f) => f.rule_code).join(", ")}`;
}, local);

qa("TC-FLD-132", "sign-up referral code: blank and unknown codes do not block sign-up; a valid code is accepted whatever its case; 100 characters and symbols are refused without a 500", async ({ browser }) => {
  return withRule("customerReferrals", REFERRALS, async () => {
    const out: string[] = [];
    const blank = await signUpWith(browser, null, "blank-code");
    out.push(`blank → setup continues (${blank.email.split("@")[0]})`);
    // Unknown code: a message on the field, then the person carries on without one.
    const email = uniqueEmail("unknown-code-ui");
    const { context, page } = await guestContext(browser);
    try {
      await signInWithCode(page, email);
      const field = page.getByTestId("signup-referral-code");
      await field.fill("x".repeat(100));
      expect((await field.inputValue()).length, "the field stops at 40").toBe(40);
      await field.fill("QAUNKNOWN99");
      await page.getByRole("button", { name: "Save and continue" }).click();
      await expect(page.getByText("This referral code is not valid.")).toBeVisible();
      await field.fill("");
      await page.getByRole("button", { name: "Save and continue" }).click();
      await expect(page.getByRole("heading", { name: "Delivery address" }), "not blocked").toBeVisible();
    } finally {
      await context.close();
    }
    out.push("unknown → 'This referral code is not valid.' on the field, then continues without it; the field stops at 40 characters");
    const referrer = await localUser("case-referrer");
    const code = await codeOf(referrer.ctx);
    const newcomer = await localUser("case-newcomer");
    const ok = await call(newcomer.ctx, "POST", "/api/me/signup-referral", { code: `  ${code.toLowerCase()}  ` });
    expectStatus(ok, 200, "lower case with spaces");
    out.push(`"  ${code.toLowerCase()}  " accepted`);
    const other = await localUser("long-code");
    for (const value of ["x".repeat(100), "!@#$%^&*()"]) {
      const res = await call(other.ctx, "POST", "/api/me/signup-referral", { code: value });
      expect(res.status, `"${value.slice(0, 12)}"`).toBe(422);
      out.push(`"${value.slice(0, 10)}…" → 422`);
    }
    return out.join("; ");
  });
}, local);
