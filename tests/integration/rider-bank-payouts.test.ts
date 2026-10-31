/**
 * Rider bank payouts (docs/gig-bank-payouts-2026-10), on real PostgreSQL with
 * the sandbox payout provider and its signed webhooks; e-mails captured.
 *
 * Covers the brief's minimum cases: a customer and a delivery partner each add
 * and verify a bank account; re-authentication before changing it; a withdrawal
 * that succeeds; one that fails and is reversed; limits; the monthly payout on
 * the 5th with eligibility edge cases (below minimum, missing KYC, unverified
 * account); duplicate-run protection; a run interrupted and re-run; retries
 * then manual review; TDS; no double payment with the weekly batch; flags off.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
  outbox: [] as { to: string; subject: string; text: string }[],
}));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    state.outbox.push(message);
  },
  EmailUnavailableError: class extends Error {},
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { PUT as myAccountPut } from "@/app/api/bank-account/route";
import { POST as startRoute } from "@/app/api/bank-account/verification/route";
import { POST as simulateRoute } from "@/app/api/bank-account/verification/simulate/route";
import { GET as adminRunsGet, POST as adminRunsPost } from "@/app/api/admin/rider-payouts/runs/route";
import { POST as reviewRoute } from "@/app/api/admin/rider-payouts/transfers/[id]/route";
import { DELETE as removeRoute } from "@/app/api/gig/bank-account/route";
import { POST as reauthRoute } from "@/app/api/gig/bank-account/reauth/route";
import { GET as quoteRoute } from "@/app/api/gig/wallet/quote/route";
import { GET as walletRoute } from "@/app/api/gig/wallet/route";
import { POST as withdrawRoute } from "@/app/api/gig/wallet/withdrawals/route";
import { encryptSecret } from "@/lib/pan-crypto";
import { RULES } from "@/server/config/rules";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  bankAccounts,
  deliveryPartnerEarnings,
  deliveryPartners,
  financeLedgerEntries,
  financialAdjustments,
  notifications,
  riderBankTransfers,
  riderPayoutRuns,
  riderPayouts,
} from "@/server/db/schema";
import { claimIntoTransfer, retryDueTransfers, unpaidBalance } from "@/server/rider-wallet/transfers";
import { runMonthlyRiderPayout } from "@/server/rider-wallet/monthly";
import { getPayoutProvider } from "@/server/payouts/providers";
import { prepareRiderPayouts } from "@/server/services/finance";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createDeliveryPartner, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; role: UserRole };
// 5 Nov 2026, 09:30 IST: payout time for October.
const PAYOUT_TIME = new Date("2026-11-05T04:00:00Z");

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

function lastCodeTo(email: string): string {
  const message = [...state.outbox].reverse().find((m) => m.to === email);
  const code = message?.subject.match(/^(\d{4,8}) /)?.[1];
  if (!code) throw new Error(`no code was emailed to ${email}`);
  return code;
}

async function flags(on: boolean) {
  for (const key of ["rider_bank_account_enabled", "rider_withdrawal_enabled", "rider_monthly_payout_enabled"] as const) {
    await setFeatureFlag(key, { enabled: on, districtCodes: null }, "rider payouts (test)", admin);
  }
}

async function rider(options: { status?: "APPROVED" | "SUSPENDED"; bank?: "VERIFIED" | "PENDING" | null; pan?: boolean; name?: string } = {}) {
  const user = await createUser({ role: "DELIVERY_PARTNER", name: options.name ?? "Asha Rider" });
  const created = await createDeliveryPartner(user.id, { status: options.status ?? "APPROVED" });
  const [partner] = await db.update(deliveryPartners).set({ fullName: options.name ?? "Asha Rider" }).where(eq(deliveryPartners.id, created.id)).returning();
  if (options.pan) await db.update(deliveryPartners).set({ panNumberEncrypted: encryptSecret("ABCPE1234F") }).where(eq(deliveryPartners.id, partner.id));
  if (options.bank !== null) {
    const status = options.bank ?? "VERIFIED";
    await db.insert(bankAccounts).values({
      userId: user.id,
      holderType: "CUSTOMER",
      method: "BANK_ACCOUNT",
      accountHolderName: options.name ?? "Asha Rider",
      accountNumberEncrypted: encryptSecret("123456789012"),
      accountNumberLast4: "9012",
      ifsc: "SBIN0001234",
      status,
      verifiedAt: status === "VERIFIED" ? new Date() : null,
    });
  }
  return { user, partner };
}

async function earn(partnerId: string, ...amounts: number[]) {
  for (const totalPaise of amounts) {
    await db.insert(deliveryPartnerEarnings).values({ deliveryPartnerId: partnerId, returnPickupId: crypto.randomUUID(), basePaise: totalPaise, distancePaise: 0, totalPaise });
  }
}

async function withdraw(user: { id: string; email: string; name: string | null }, amountPaise: number) {
  signIn(user, "DELIVERY_PARTNER");
  const sent = await call(withdrawRoute, "/api/gig/wallet/withdrawals", { method: "POST", body: { amountPaise } });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  return call(withdrawRoute, "/api/gig/wallet/withdrawals", { method: "POST", body: { amountPaise, code: lastCodeTo(user.email) } });
}

beforeEach(async () => {
  state.session = null;
  state.outbox = [];
  resetRateLimits();
  await resetDatabase();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setRule("bankAccounts", { enabled: true }, admin);
  // Several codes per test: no cooldown between them (the OTP limits have their own tests).
  await setRule("otp", { ...RULES.otp.defaults, resendCooldownSeconds: 0, maxResendsPerWindow: 20 }, admin);
  await flags(true);
});

describe("flags off", () => {
  it("every new route answers 404 and the bank account behaves as before (no code asked)", async () => {
    await flags(false);
    const { user } = await rider();
    signIn(user, "DELIVERY_PARTNER");
    expect((await call(walletRoute, "/api/gig/wallet")).status).toBe(404);
    expect((await call(withdrawRoute, "/api/gig/wallet/withdrawals", { method: "POST", body: { amountPaise: 10_000 } })).status).toBe(404);
    const change = await call(myAccountPut, "/api/bank-account", {
      method: "PUT",
      body: { method: "BANK_ACCOUNT", accountHolderName: "Asha Rider", accountNumber: "987654321098", confirmAccountNumber: "987654321098", ifsc: "HDFC0001234" },
    });
    expect(change.status).toBe(200);
    expect(await runMonthlyRiderPayout({ now: PAYOUT_TIME })).toEqual({ skipped: "Monthly rider payout is off (feature flag)." });
  });
});

describe("bank account for both roles", () => {
  it("a customer and a delivery partner each add and verify their account; numbers are masked", async () => {
    for (const role of ["CUSTOMER", "DELIVERY_PARTNER"] as const) {
      const user = await createUser({ role, name: "Ravi Kumar" });
      if (role === "DELIVERY_PARTNER") await createDeliveryPartner(user.id);
      signIn(user, role);
      const saved = await call(myAccountPut, "/api/bank-account", {
        method: "PUT",
        body: { method: "BANK_ACCOUNT", accountHolderName: "Ravi Kumar", accountNumber: "123456789012", confirmAccountNumber: "123456789012", ifsc: "SBIN0001234" },
      });
      expect(saved.status).toBe(200);
      expect(saved.body.accountNumberMasked).toBe("••••9012");
      expect(JSON.stringify(saved.body)).not.toContain("123456789012");
      const started = await call(startRoute, "/api/bank-account/verification", { method: "POST", body: { accountId: saved.body.id } });
      expect(started.status).toBe(201);
      const verified = await call(simulateRoute, "/api/bank-account/verification/simulate", { method: "POST", body: { gatewayOrderId: started.body.gatewayOrderId, method: "UPI", outcome: "SUCCESS" } });
      expect(verified.body.status).toBe("VERIFIED");
      const [row] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, saved.body.id));
      expect(row.accountNumberEncrypted).not.toContain("123456789012");
    }
  });

  it("a delivery partner's verified account changes or is removed only after an emailed code, once", async () => {
    const { user } = await rider();
    signIn(user, "DELIVERY_PARTNER");
    const body = { method: "BANK_ACCOUNT", accountHolderName: "Asha Rider", accountNumber: "987654321098", confirmAccountNumber: "987654321098", ifsc: "HDFC0001234" };
    const refused = await call(myAccountPut, "/api/bank-account", { method: "PUT", body });
    expect(refused.status).toBe(403);
    expect(refused.body.error.details.reason).toBe("REAUTH_REQUIRED");

    expect((await call(reauthRoute, "/api/gig/bank-account/reauth", { method: "POST", body: {} })).status).toBe(200);
    expect((await call(reauthRoute, "/api/gig/bank-account/reauth", { method: "POST", body: { code: "000000" } })).status).toBeGreaterThanOrEqual(400);
    expect((await call(reauthRoute, "/api/gig/bank-account/reauth", { method: "POST", body: { code: lastCodeTo(user.email) } })).status).toBe(200);
    const changed = await call(myAccountPut, "/api/bank-account", { method: "PUT", body });
    expect(changed.status).toBe(200);
    expect(changed.body.status).toBe("PENDING"); // new details need their own verification

    // A customer (not a rider) is never asked for a code.
    const customer = await createUser();
    signIn(customer, "CUSTOMER");
    expect((await call(myAccountPut, "/api/bank-account", { method: "PUT", body })).status).toBe(200);

    // Removal: needs a fresh code too.
    const other = await rider();
    signIn(other.user, "DELIVERY_PARTNER");
    expect((await call(removeRoute, "/api/gig/bank-account", { method: "DELETE" })).status).toBe(403);
    await call(reauthRoute, "/api/gig/bank-account/reauth", { method: "POST", body: {} });
    await call(reauthRoute, "/api/gig/bank-account/reauth", { method: "POST", body: { code: lastCodeTo(other.user.email) } });
    expect((await call(removeRoute, "/api/gig/bank-account", { method: "DELETE" })).status).toBe(200);
    const current = await db.select().from(bankAccounts).where(and(eq(bankAccounts.userId, other.user.id), eq(bankAccounts.isCurrent, true)));
    expect(current).toHaveLength(0);
  });
});

describe("withdrawals", () => {
  it("succeeds: fee and settlement shown first, code required, debit only for what was sent, rest stays", async () => {
    const { user, partner } = await rider();
    await earn(partner.id, 30_000, 30_000, 30_000);
    signIn(user, "DELIVERY_PARTNER");
    const quote = await call(quoteRoute, "/api/gig/wallet/quote?amountPaise=50000");
    expect(quote.body).toMatchObject({ amountPaise: 50_000, feePaise: 0, tdsPaise: 0, netPaise: 50_000, problem: null });
    expect(quote.body.settlement).toContain("IMPS");
    expect(quote.body.account).toContain("••••9012");

    // A wrong code withdraws nothing.
    await call(withdrawRoute, "/api/gig/wallet/withdrawals", { method: "POST", body: { amountPaise: 50_000 } });
    expect((await call(withdrawRoute, "/api/gig/wallet/withdrawals", { method: "POST", body: { amountPaise: 50_000, code: "000000" } })).status).toBeGreaterThanOrEqual(400);
    expect((await unpaidBalance(partner.id)).availablePaise).toBe(90_000);

    const done = await withdraw(user, 50_000);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({ kind: "WITHDRAWAL", status: "SUCCESS", grossPaise: 50_000, netPaise: 50_000, mode: "IMPS" });
    expect(done.body.utr).toMatch(/^SBXN\d{12}$/);
    const [payout] = await db.select().from(riderPayouts).where(eq(riderPayouts.id, done.body.payoutId));
    expect(payout).toMatchObject({ status: "PAID", amountPaise: 50_000, paymentReference: done.body.utr });
    expect((await unpaidBalance(partner.id)).availablePaise).toBe(40_000);
    const ledger = await db.select().from(financeLedgerEntries).where(eq(financeLedgerEntries.sourceId, payout.id));
    expect(ledger.map((l) => [l.entryType, l.amountPaise])).toEqual([["RIDER_PAYOUT", 50_000]]);
    const notes = await db.select().from(notifications).where(eq(notifications.userId, user.id));
    expect(notes.map((n) => n.type).sort()).toEqual(["delivery.rider_payout_paid", "delivery.rider_withdrawal_sent"]);

    // The weekly batch takes only what is left: nothing is paid twice.
    const weekly = await prepareRiderPayouts(mondayOfThisWeek(), { id: admin.id, role: "ADMIN" });
    const mine = weekly.filter((p) => p.deliveryPartnerId === partner.id);
    expect(mine.reduce((s, p) => s + p.amountPaise, 0)).toBe(40_000);
  });

  it("fails at the bank and is reversed: the amount is back in the balance and the rider is told", async () => {
    const { user, partner } = await rider();
    await earn(partner.id, 60_098);
    const done = await withdraw(user, 60_098); // the sandbox always refuses …98 paise
    expect(done.status).toBe(201);
    expect(done.body.status).toBe("RELEASED");
    const [payout] = await db.select().from(riderPayouts).where(eq(riderPayouts.id, done.body.payoutId));
    expect(payout.status).toBe("CANCELLED");
    expect((await unpaidBalance(partner.id)).availablePaise).toBe(60_098);
    const [note] = await db.select().from(notifications).where(and(eq(notifications.userId, user.id), eq(notifications.type, "delivery.rider_payout_failed")));
    expect(note.body).toContain("back in your balance");
  });

  it("a partial withdrawal that fails gives back exactly what was taken", async () => {
    const { user, partner } = await rider();
    await earn(partner.id, 20_000, 30_000);
    const done = await withdraw(user, 10_098);
    expect(done.body.status).toBe("RELEASED");
    expect((await unpaidBalance(partner.id)).availablePaise).toBe(50_000);
  });

  it("limits: minimum, maximum, balance, daily cap; not before approval or a verified account; never a customer", async () => {
    const { user, partner } = await rider();
    await earn(partner.id, 1_500_000);
    signIn(user, "DELIVERY_PARTNER");
    for (const [amountPaise, text] of [
      [5_000, "smallest"],
      [1_000_100, "largest"],
    ] as const) {
      const quote = await call(quoteRoute, `/api/gig/wallet/quote?amountPaise=${amountPaise}`);
      expect(quote.body.problem).toContain(text);
    }
    expect((await withdraw(user, 900_000)).body.status).toBe("SUCCESS");
    const capped = await withdraw(user, 200_000);
    expect(capped.status).toBe(422);
    expect(capped.body.error.message).toContain("more today");

    const poor = await rider();
    await earn(poor.partner.id, 15_000);
    expect((await withdraw(poor.user, 20_000)).body.error.message).toContain("up to");

    const pending = await rider({ bank: "PENDING" });
    await earn(pending.partner.id, 50_000);
    signIn(pending.user, "DELIVERY_PARTNER");
    expect((await call(withdrawRoute, "/api/gig/wallet/withdrawals", { method: "POST", body: { amountPaise: 20_000, code: "123456" } })).body.error.details.reason).toBe("BANK_NOT_VERIFIED");

    const suspended = await rider({ status: "SUSPENDED" });
    signIn(suspended.user, "DELIVERY_PARTNER");
    expect((await call(withdrawRoute, "/api/gig/wallet/withdrawals", { method: "POST", body: { amountPaise: 20_000 } })).body.error.details.reason).toBe("KYC_INCOMPLETE");

    const customer = await createUser();
    signIn(customer, "CUSTOMER");
    expect((await call(withdrawRoute, "/api/gig/wallet/withdrawals", { method: "POST", body: { amountPaise: 20_000 } })).status).toBe(403);
  });

  it("COD cash a rider owes lowers what can be withdrawn", async () => {
    const { user, partner } = await rider();
    await earn(partner.id, 50_000);
    await db.insert(financialAdjustments).values({ type: "DELIVERY_ADJUSTMENT", party: "RIDER", status: "PENDING", deliveryPartnerId: partner.id, amountPaise: -30_000, reason: "COD cash held", idempotencyKey: `cod-${partner.id}` });
    signIn(user, "DELIVERY_PARTNER");
    expect((await call(walletRoute, "/api/gig/wallet")).body.balance.availablePaise).toBe(20_000);
    expect((await withdraw(user, 25_000)).status).toBe(422);
  });
});

describe("monthly payout on the 5th", () => {
  it("pays the eligible, carries forward the rest with the reason, and never runs twice", async () => {
    const paid = await rider({ name: "Paid Rider" });
    await earn(paid.partner.id, 40_000, 20_000);
    const small = await rider({ name: "Small Rider" });
    await earn(small.partner.id, 5_000);
    const noKyc = await rider({ status: "SUSPENDED", name: "No KYC" });
    await earn(noKyc.partner.id, 50_000);
    const unverified = await rider({ bank: "PENDING", name: "Unverified" });
    await earn(unverified.partner.id, 50_000);

    expect(await runMonthlyRiderPayout({ now: new Date("2026-11-05T03:00:00Z") })).toEqual({ skipped: "Not payout time." });
    const result = await runMonthlyRiderPayout({ now: PAYOUT_TIME });
    expect(result).toMatchObject({ month: "2026-10", created: 1, skipped: 3, alreadyDone: false });

    const [run] = await db.select().from(riderPayoutRuns);
    expect(run).toMatchObject({ periodMonth: "2026-10", status: "COMPLETED", paid: 1, eligible: 1, skipped: 3, grossPaise: 60_000, netPaise: 60_000 });
    const reasons = Object.fromEntries((run.summary as { skipped: { name: string; reason: string }[] }).skipped.map((s) => [s.name, s.reason]));
    expect(reasons).toEqual({ "Small Rider": "BELOW_MINIMUM", "No KYC": "KYC_INCOMPLETE", Unverified: "BANK_NOT_VERIFIED" });
    const [t] = await db.select().from(riderBankTransfers).where(eq(riderBankTransfers.deliveryPartnerId, paid.partner.id));
    expect(t).toMatchObject({ kind: "MONTHLY", runId: run.id, status: "SUCCESS", mode: "NEFT", retryCount: 0 });
    expect((await unpaidBalance(small.partner.id)).availablePaise).toBe(5_000);
    const carried = await db.select().from(notifications).where(eq(notifications.type, "delivery.rider_payout_carried"));
    expect(carried).toHaveLength(3);

    // Duplicate-run protection: the hourly job and an admin both try again.
    expect(await runMonthlyRiderPayout({ now: new Date(PAYOUT_TIME.getTime() + 3_600_000) })).toMatchObject({ alreadyDone: true, created: 0 });
    signIn(admin as never, "ADMIN");
    const again = await call(adminRunsPost, "/api/admin/rider-payouts/runs", { method: "POST", body: { month: "2026-10" } });
    // Run for real today (31 Oct 2026): a month is never paid before it is over.
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain("not over yet");
    expect(await db.select().from(riderBankTransfers)).toHaveLength(1);
    expect(await db.select().from(riderPayoutRuns)).toHaveLength(1);
  });

  it("an interrupted run is resumed: the unsent payment is sent once, the others paid, nobody twice", async () => {
    const a = await rider({ name: "A" });
    await earn(a.partner.id, 30_000);
    const b = await rider({ name: "B" });
    await earn(b.partner.id, 40_000);
    // The run stopped right after A's payment was committed, before the bank was called.
    const [run] = await db.insert(riderPayoutRuns).values({ periodMonth: "2026-10" }).returning();
    const [account] = await db.select().from(bankAccounts).where(eq(bankAccounts.userId, a.user.id));
    await db.transaction((tx) =>
      claimIntoTransfer(tx, {
        deliveryPartnerId: a.partner.id,
        userId: a.user.id,
        kind: "MONTHLY",
        before: null,
        amountPaise: null,
        check: () => {},
        feePaise: 0,
        account,
        provider: getPayoutProvider("SANDBOX")!,
        mode: "NEFT",
        runId: run.id,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        actor: { id: null, role: null },
      }),
    );

    const resumed = await runMonthlyRiderPayout({ now: PAYOUT_TIME });
    expect(resumed).toMatchObject({ resumed: true, created: 1, sent: 2 });
    const transfers = await db.select().from(riderBankTransfers).where(eq(riderBankTransfers.runId, run.id));
    expect(transfers.map((t) => t.status)).toEqual(["SUCCESS", "SUCCESS"]);
    const [after] = await db.select().from(riderPayoutRuns).where(eq(riderPayoutRuns.id, run.id));
    expect(after).toMatchObject({ status: "COMPLETED", runs: 2, paid: 2, grossPaise: 70_000 });
    expect(await runMonthlyRiderPayout({ now: PAYOUT_TIME })).toMatchObject({ alreadyDone: true });
  });

  it("retries a failed transfer, then flags it for finance; finance returns it to the balance", async () => {
    const flaky = await rider({ name: "Flaky" });
    await earn(flaky.partner.id, 30_099); // …99: fails once, then succeeds
    const broken = await rider({ name: "Broken" });
    await earn(broken.partner.id, 30_098); // …98: always fails

    await runMonthlyRiderPayout({ now: PAYOUT_TIME });
    let rows = await db.select().from(riderBankTransfers);
    const byName = async () => Object.fromEntries((await db.select().from(riderBankTransfers)).map((t) => [t.deliveryPartnerId === flaky.partner.id ? "flaky" : "broken", t]));
    expect((await byName()).flaky).toMatchObject({ status: "FAILED", retryCount: 0, needsReview: false });

    let now = new Date();
    for (let i = 0; i < 4; i++) {
      now = new Date(now.getTime() + 10 * 3_600_000);
      await retryDueTransfers(now);
    }
    const t = await byName();
    expect(t.flaky).toMatchObject({ status: "SUCCESS", retryCount: 1 });
    expect(t.broken).toMatchObject({ status: "FAILED", retryCount: 3, needsReview: true });
    const [run] = await db.select().from(riderPayoutRuns);
    expect(run.status).toBe("RUNNING"); // refreshed by the hourly job below
    const { refreshOpenRuns } = await import("@/server/rider-wallet/monthly");
    await refreshOpenRuns();
    expect((await db.select().from(riderPayoutRuns))[0]).toMatchObject({ status: "COMPLETED_WITH_FAILURES", paid: 1, failed: 1 });

    signIn(admin as never, "ADMIN");
    const listed = await call(adminRunsGet, "/api/admin/rider-payouts/runs");
    expect(listed.body.review.map((r: { id: string }) => r.id)).toEqual([t.broken.id]);
    const released = await call(reviewRoute, `/api/admin/rider-payouts/transfers/${t.broken.id}`, { method: "POST", body: { action: "release", note: "Account closed" }, params: { id: t.broken.id } });
    expect(released.body.status).toBe("RELEASED");
    expect((await unpaidBalance(broken.partner.id)).availablePaise).toBe(30_098);
    rows = await db.select().from(riderBankTransfers);
    expect(rows).toHaveLength(2);

    // A rider cannot see or act on the admin view.
    signIn(broken.user, "DELIVERY_PARTNER");
    expect((await call(adminRunsGet, "/api/admin/rider-payouts/runs")).status).toBe(403);
  });

  it("deducts TDS s.194C on a payment above ₹30,000 (20% without PAN, 1% with)", async () => {
    const noPan = await rider({ name: "No PAN" });
    await earn(noPan.partner.id, 3_500_000);
    const withPan = await rider({ name: "With PAN", pan: true });
    await earn(withPan.partner.id, 3_500_000);
    await runMonthlyRiderPayout({ now: PAYOUT_TIME });
    const rows = Object.fromEntries((await db.select().from(riderBankTransfers)).map((t) => [t.deliveryPartnerId === withPan.partner.id ? "pan" : "nopan", t]));
    expect(rows.pan).toMatchObject({ grossPaise: 3_500_000, tdsPaise: 35_000, tdsRateBp: 100, netPaise: 3_465_000, status: "SUCCESS" });
    expect(rows.nopan).toMatchObject({ tdsPaise: 700_000, tdsRateBp: 2000, netPaise: 2_800_000 });
  });

  it("earnings after the month's end wait for the next run", async () => {
    const r = await rider();
    await earn(r.partner.id, 30_000);
    await db.insert(deliveryPartnerEarnings).values({ deliveryPartnerId: r.partner.id, returnPickupId: crypto.randomUUID(), basePaise: 20_000, distancePaise: 0, totalPaise: 20_000, createdAt: new Date("2026-11-02T06:00:00Z") });
    await runMonthlyRiderPayout({ now: PAYOUT_TIME });
    const [t] = await db.select().from(riderBankTransfers);
    expect(t.grossPaise).toBe(30_000);
    expect((await unpaidBalance(r.partner.id)).availablePaise).toBe(20_000);
  });
});

/** Monday of the current IST week (prepareRiderPayouts accepts a started week). */
function mondayOfThisWeek(): string {
  const ist = new Date(Date.now() + 330 * 60_000);
  const day = (ist.getUTCDay() + 6) % 7;
  ist.setUTCDate(ist.getUTCDate() - day);
  return ist.toISOString().slice(0, 10);
}
