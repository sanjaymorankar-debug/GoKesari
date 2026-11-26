/**
 * Shop registration subscription (0210; owner brief 25-Nov-2026; docs/shop-registration-subscription-2026-11).
 * Real PostgreSQL. Covers the brief's test list that runs without a phone:
 *   new registration payment → 1 year · unpaid reminders + auto payment link · migration of existing shops ·
 *   expiry reminder days · bulk reminders · link create / cancel / expire · gateway success / failure /
 *   duplicate · admin expiry change + audit · offline Mark as paid · grace and expired (hidden, no new
 *   orders) · renewal reactivation · role access.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { auditLogs, notifications, paymentIntents, shopRegistrationLinks, shopRegistrationMigrationReports, shopRegistrationReminders, shops } from "@/server/db/schema";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { resetRateLimits } from "@/server/api/rate-limit";
import { withWalletGate } from "@/server/services/serviceability";
import { recordPayment } from "@/server/services/shop-payments";
import { getPublicShopBySlug, searchShops } from "@/server/services/shops";
import { clearRuleCache, setRule } from "@/server/services/settings";
import {
  changeRegistrationExpiry,
  createRegistrationLink,
  listShopRegistrations,
  markRegistrationPaid,
  requestRegistrationFee,
  runRegistrationSubscriptionJob,
  sendRegistrationReminders,
  syncRegistrationStatuses,
} from "@/server/services/shop-registration-subscription";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const DAY = 86_400_000;
const FEE = 100_000;

let admin: { id: string; role: "ADMIN" };

beforeEach(async () => {
  resetRateLimits();
  clearRuleCache();
  await resetDatabase();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
});

async function shopRow(id: string) {
  const [row] = await db.select().from(shops).where(eq(shops.id, id));
  return row;
}

/** 10.00 IST on the day `now` falls in (IST) — after the 09.00 reminder hour. */
function tenAmIst(now = new Date()): Date {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
  return new Date(`${day}T10:00:00+05:30`);
}

async function remindersOn() {
  await setRule("shopMembership", { remindersEnabled: true, renewalCheckoutEnabled: true }, admin);
  clearRuleCache();
}

/** A live shop whose fee is paid and whose registration ends `days` from now. */
async function liveShop(days: number, name = "Live Shop") {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { status: "APPROVED", registrationFeePaise: FEE, name });
  await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: FEE }, admin);
  const until = new Date(Date.now() + days * DAY);
  await db.update(shops).set({ membershipValidUntil: until }).where(eq(shops.id, shop.id));
  await syncRegistrationStatuses();
  return { owner, shop, until };
}

/** A shop registered `daysAgo` days ago that has not paid its fee. */
async function unpaidShop(daysAgo: number, name = "Unpaid Shop") {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", registrationFeePaise: FEE, name });
  await db.update(shops).set({ createdAt: new Date(Date.now() - daysAgo * DAY) }).where(eq(shops.id, shop.id));
  await syncRegistrationStatuses();
  return { owner, shop };
}

describe("new registration payment → 1 year", () => {
  it("UNPAID until paid; the fee starts the year on the payment date", async () => {
    const { shop } = await unpaidShop(0);
    expect((await shopRow(shop.id)).registrationStatus).toBe("UNPAID");
    const paidAt = new Date();
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: FEE, paidAt }, admin);
    const row = await shopRow(shop.id);
    expect(row.registrationStatus).toBe("ACTIVE");
    expect(row.registrationStartDate?.getTime()).toBe(paidAt.getTime());
    const expected = new Date(paidAt);
    expected.setUTCMonth(expected.getUTCMonth() + 12);
    expect(Math.abs(row.membershipValidUntil!.getTime() - expected.getTime())).toBeLessThan(3 * DAY);
    expect(row.lastRegistrationPaymentAt?.getTime()).toBe(paidAt.getTime());
  });

  it("a part payment keeps it UNPAID (no year yet)", async () => {
    const { shop } = await unpaidShop(0);
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: FEE / 2 }, admin);
    const row = await shopRow(shop.id);
    expect(row.membershipValidUntil).toBeNull();
    expect(row.registrationStatus).toBe("UNPAID");
  });
});

describe("unpaid reminders and payment links", () => {
  it("day 1 after registration: one reminder (in-app + push + e-mail) with an auto-created link; not twice the same day", async () => {
    await remindersOn();
    const { owner, shop } = await unpaidShop(1);
    const now = tenAmIst();
    const first = await runRegistrationSubscriptionJob(now);
    expect(first.reminders).toMatchObject({ sent: 1 });
    const second = await runRegistrationSubscriptionJob(now);
    expect(second.reminders).toMatchObject({ sent: 0 });

    const log = await db.select().from(shopRegistrationReminders).where(eq(shopRegistrationReminders.shopId, shop.id));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: "UNPAID", stage: "U1", channels: "IN_APP,PUSH,EMAIL" });
    const [link] = await db.select().from(shopRegistrationLinks).where(eq(shopRegistrationLinks.shopId, shop.id));
    expect(link).toMatchObject({ kind: "REGISTRATION", status: "ACTIVE", amountPaise: FEE, createdVia: "REMINDER" });
    const [notice] = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.registration_reminder")));
    expect(notice.body).toContain("will not receive orders");
    expect(notice.body).toContain("नोंदणी शुल्क"); // Marathi
  });

  it("before 09.00 IST nothing is sent; reminders off sends nothing", async () => {
    const { shop } = await unpaidShop(1);
    const off = await runRegistrationSubscriptionJob(tenAmIst());
    expect(String(off.reminders)).toContain("off");
    await remindersOn();
    const early = new Date(tenAmIst().getTime() - 2 * 3_600_000); // 08.00 IST
    const r = await runRegistrationSubscriptionJob(early);
    expect(String(r.reminders)).toContain("09.00 IST");
    expect(await db.select().from(shopRegistrationReminders).where(eq(shopRegistrationReminders.shopId, shop.id))).toHaveLength(0);
  });

  it("day 2 sends nothing; day 3, 7 and weekly after (14) do", async () => {
    await remindersOn();
    for (const [daysAgo, expected] of [[2, 0], [3, 1], [7, 1], [10, 0], [14, 1]] as const) {
      const { shop } = await unpaidShop(daysAgo, `Unpaid ${daysAgo}`);
      await runRegistrationSubscriptionJob(tenAmIst());
      const rows = await db.select().from(shopRegistrationReminders).where(eq(shopRegistrationReminders.shopId, shop.id));
      expect(rows.length, `day ${daysAgo}`).toBe(expected);
    }
  });

  it("a new link cancels the older one; an admin amount for an unpaid shop becomes what is owed; links expire", async () => {
    const { shop } = await unpaidShop(0);
    const first = await createRegistrationLink(shop.id, {}, admin);
    const second = await createRegistrationLink(shop.id, { amountPaise: 80_000, validityDays: 2 }, admin);
    const links = await db.select().from(shopRegistrationLinks).where(eq(shopRegistrationLinks.shopId, shop.id));
    expect(links.find((l) => l.id === first.link.id)?.status).toBe("CANCELLED");
    expect(links.find((l) => l.id === second.link.id)).toMatchObject({ status: "ACTIVE", amountPaise: 80_000 });
    expect((await shopRow(shop.id)).registrationFeePaise).toBe(80_000);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, shop.id), eq(auditLogs.action, "shop.registration_link_cancelled")));
    expect(audit).toHaveLength(1);

    await runRegistrationSubscriptionJob(new Date(Date.now() + 3 * DAY));
    const [after] = await db.select().from(shopRegistrationLinks).where(eq(shopRegistrationLinks.id, second.link.id));
    expect(after.status).toBe("EXPIRED");
  });

  it("paying the link (gateway webhook) activates the year once; a replay or failure changes nothing", async () => {
    const { shop } = await unpaidShop(0);
    const { link } = await createRegistrationLink(shop.id, {}, admin);
    await simulateSandboxCheckout({ ref: link.paymentIntentId, viewerId: null, outcome: "SUCCESS" });
    const row = await shopRow(shop.id);
    expect(row.feePaymentStatus).toBe("PAID");
    expect(row.registrationStatus).toBe("ACTIVE");
    const until = row.membershipValidUntil!.getTime();
    const [paid] = await db.select().from(shopRegistrationLinks).where(eq(shopRegistrationLinks.id, link.id));
    expect(paid.status).toBe("PAID");
    // Duplicate webhook: the capture is idempotent.
    const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, link.paymentIntentId));
    const { onShopRegistrationFeeCaptured } = await import("@/server/services/operator-limited");
    const { toIntentRef } = await import("@/server/payments/intent-store");
    await onShopRegistrationFeeCaptured(toIntentRef(intent), db);
    expect((await shopRow(shop.id)).membershipValidUntil!.getTime()).toBe(until);
  });

  it("a failed link payment leaves the shop UNPAID", async () => {
    const { shop } = await unpaidShop(0);
    const { link } = await createRegistrationLink(shop.id, {}, admin);
    await simulateSandboxCheckout({ ref: link.paymentIntentId, viewerId: null, outcome: "FAILURE" });
    const row = await shopRow(shop.id);
    expect(row.registrationStatus).toBe("UNPAID");
    expect(row.membershipValidUntil).toBeNull();
  });
});

describe("ask a live ₹0 shop for its registration fee (26-Nov-2026)", () => {
  /** Approved and live with fee ₹0 marked paid (went live during the free weeks). */
  async function freeLiveShop(name = "Free Live Shop") {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "APPROVED", registrationFeePaise: 0, name });
    await db.update(shops).set({ feePaymentStatus: "PAID", amountPaidPaise: 0, createdAt: new Date(Date.now() - 31 * DAY) }).where(eq(shops.id, shop.id));
    await syncRegistrationStatuses();
    return { owner, shop };
  }

  it("the list offers it; asking makes the fee owed, sends a link, stays live; paying opens the year", async () => {
    const { owner, shop } = await freeLiveShop();
    const before = (await listShopRegistrations({ q: "Free Live Shop" })).rows[0];
    expect(before).toMatchObject({ status: "ACTIVE", canRequestFee: true });
    const noFee = await listShopRegistrations({ filter: "NO_FEE" });
    expect(noFee.rows.map((r) => r.shopId)).toEqual([shop.id]);
    expect(noFee.counts.NO_FEE).toBe(1);

    await expect(requestRegistrationFee(shop.id, { reason: "no" }, admin)).rejects.toMatchObject({ status: 422 });
    const r = await requestRegistrationFee(shop.id, { amountPaise: 117_800, reason: "went live without paying" }, admin);
    expect(r.amountPaise).toBe(117_800);
    const row = await shopRow(shop.id);
    expect(row).toMatchObject({ registrationFeePaise: 117_800, feePaymentStatus: "PENDING", registrationStatus: "UNPAID", status: "APPROVED" });
    const [link] = await db.select().from(shopRegistrationLinks).where(eq(shopRegistrationLinks.shopId, shop.id));
    expect(link).toMatchObject({ kind: "REGISTRATION", status: "ACTIVE", amountPaise: 117_800, createdVia: "ADMIN" });
    const [sent] = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.registration_payment_link")));
    expect(sent.body).toContain("₹1,178");
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, shop.id), eq(auditLogs.action, "shop.registration_fee_requested")));
    expect(audit).toHaveLength(1);
    expect((await listShopRegistrations({ q: "Free Live Shop" })).rows[0]).toMatchObject({ status: "UNPAID", canRequestFee: false, amountDuePaise: 117_800 });
    expect((await listShopRegistrations({ filter: "NO_FEE" })).rows).toHaveLength(0);
    expect((await listShopRegistrations({ filter: "UNPAID" })).rows.map((r) => r.shopId)).toContain(shop.id);

    // Asking twice is refused; still live in search meanwhile.
    await expect(requestRegistrationFee(shop.id, { reason: "again please" }, admin)).rejects.toMatchObject({ status: 409 });

    await simulateSandboxCheckout({ ref: link.paymentIntentId, viewerId: null, outcome: "SUCCESS" });
    const paid = await shopRow(shop.id);
    expect(paid).toMatchObject({ feePaymentStatus: "PAID", registrationStatus: "ACTIVE", amountPaidPaise: 117_800 });
    expect(paid.membershipValidUntil).not.toBeNull();
  });

  it("weekly unpaid reminder to a live shop leaves out the no-orders line", async () => {
    await remindersOn();
    const { owner, shop } = await freeLiveShop("Weekly Live Shop");
    await requestRegistrationFee(shop.id, { amountPaise: 117_800, reason: "went live without paying" }, admin);
    await db.update(shops).set({ createdAt: new Date(Date.now() - 14 * DAY) }).where(eq(shops.id, shop.id));
    await runRegistrationSubscriptionJob(tenAmIst());
    const [notice] = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.registration_reminder")));
    expect(notice.body).toContain("Please pay the registration fee");
    expect(notice.body).not.toContain("will not receive orders");
  });

  it("a shop that paid before, or is unpaid already, is refused", async () => {
    const { shop: paid } = await liveShop(200, "Paid Before");
    expect((await listShopRegistrations({ q: "Paid Before" })).rows[0].canRequestFee).toBe(false);
    await expect(requestRegistrationFee(paid.id, { reason: "should fail" }, admin)).rejects.toMatchObject({ status: 409 });
    const { shop: unpaid } = await unpaidShop(2, "Already Unpaid");
    await expect(requestRegistrationFee(unpaid.id, { reason: "should fail" }, admin)).rejects.toMatchObject({ status: 409 });
  });
});

describe("expiry reminders, grace and expiry", () => {
  it("15 days before: one RENEWAL reminder E15; 10 days before: none", async () => {
    await remindersOn();
    const a = await liveShop(15, "Fifteen");
    const b = await liveShop(10, "Ten");
    await runRegistrationSubscriptionJob(tenAmIst());
    const rows = await db.select().from(shopRegistrationReminders);
    expect(rows.filter((r) => r.shopId === a.shop.id).map((r) => r.stage)).toEqual(["E15"]);
    expect(rows.filter((r) => r.shopId === b.shop.id)).toHaveLength(0);
    expect((await shopRow(a.shop.id)).registrationStatus).toBe("EXPIRING_SOON");
  });

  it("grace: still found by customers (red banner); past grace: EXPIRED, hidden, closed to new orders", async () => {
    const grace = await liveShop(-3, "Grace Shop");
    const expired = await liveShop(-30, "Expired Shop");
    await syncRegistrationStatuses();
    expect((await shopRow(grace.shop.id)).registrationStatus).toBe("GRACE");
    expect((await shopRow(expired.shop.id)).registrationStatus).toBe("EXPIRED");
    expect(await getPublicShopBySlug(grace.shop.slug)).toBeTruthy();
    expect(await getPublicShopBySlug(expired.shop.slug)).toBeUndefined();
    const found = (await searchShops({ query: "Shop" })).map((s) => s.id);
    expect(found).toContain(grace.shop.id);
    expect(found).not.toContain(expired.shop.id);
    const gated = await withWalletGate([await shopRow(expired.shop.id)]);
    expect(gated[0].ordersPaused).toBe(true);
  });

  it("renewal marked as paid offline reactivates at once: new expiry = max(expiry, payment) + 12 months", async () => {
    const { shop } = await liveShop(-30, "Lapsed");
    await syncRegistrationStatuses();
    expect(await getPublicShopBySlug(shop.slug)).toBeUndefined();
    await expect(markRegistrationPaid(shop.id, { reference: "", note: "cash", method: "CASH" }, admin)).rejects.toMatchObject({ status: 422 });
    const r = await markRegistrationPaid(shop.id, { reference: "CASH-001", note: "cash at office", method: "CASH" }, admin);
    expect(r.extendedTo).toBeTruthy();
    const row = await shopRow(shop.id);
    expect(row.registrationStatus).toBe("ACTIVE");
    expect(row.membershipValidUntil!.getTime()).toBeGreaterThan(Date.now() + 360 * DAY);
    expect(await getPublicShopBySlug(shop.slug)).toBeTruthy();
    // Same reference twice is refused (one bank / UPI transaction is one payment).
    await expect(markRegistrationPaid(shop.id, { reference: "CASH-001", note: "again", method: "CASH" }, admin)).rejects.toMatchObject({ status: 409 });
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, shop.id), eq(auditLogs.action, "shop.registration_marked_paid")));
    expect(audit[0].newValue).toMatchObject({ reference: "CASH-001", note: "cash at office", extended: true });
  });

  it("an early renewal extends from the current expiry", async () => {
    const { shop, until } = await liveShop(20, "Early");
    await markRegistrationPaid(shop.id, { reference: "UPI-123", note: "UPI to office", method: "UPI" }, admin);
    const row = await shopRow(shop.id);
    const expected = new Date(until);
    expected.setUTCMonth(expected.getUTCMonth() + 12);
    expect(Math.abs(row.membershipValidUntil!.getTime() - expected.getTime())).toBeLessThan(2 * DAY);
  });
});

describe("admin expiry change, bulk reminders, list, roles", () => {
  it("extend / expire now with a mandatory reason; audited with old and new value; owner told", async () => {
    const { owner, shop, until } = await liveShop(40, "Change Me");
    await expect(changeRegistrationExpiry(shop.id, { mode: "EXTEND", days: 10 }, "", admin)).rejects.toMatchObject({ status: 422 });
    await changeRegistrationExpiry(shop.id, { mode: "EXTEND", days: 10 }, "Goodwill for outage", admin);
    expect((await shopRow(shop.id)).membershipValidUntil!.getTime()).toBe(until.getTime() + 10 * DAY);
    await changeRegistrationExpiry(shop.id, { mode: "EXPIRE_NOW" }, "Fraud check failed", admin);
    const row = await shopRow(shop.id);
    expect(row.registrationStatus).toBe("EXPIRED");
    expect(await getPublicShopBySlug(shop.slug)).toBeUndefined();
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, shop.id), eq(auditLogs.action, "shop.registration_expiry_changed")));
    expect(audit).toHaveLength(2);
    expect(audit.find((a) => (a.newValue as { mode: string }).mode === "EXPIRE_NOW")?.newValue).toMatchObject({ reason: "Fraud check failed" });
    expect((audit[0].previousValue as { expiry: string | null }).expiry).toBeTruthy();
    const told = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.registration_expiry_changed")));
    expect(told.length).toBe(2);
  });

  it("bulk reminder to unpaid and expiring shops; active shops are skipped", async () => {
    const u = await unpaidShop(5, "Bulk Unpaid");
    const e = await liveShop(5, "Bulk Expiring");
    const a = await liveShop(200, "Bulk Active");
    const r = await sendRegistrationReminders([u.shop.id, e.shop.id, a.shop.id], admin);
    expect(r.sent).toBe(2);
    expect(r.skipped).toEqual([{ shopId: a.shop.id, reason: "registration active — nothing due" }]);
    const kinds = (await db.select().from(shopRegistrationReminders)).map((x) => `${x.kind}:${x.stage}`).sort();
    expect(kinds).toEqual(["RENEWAL:MANUAL", "UNPAID:MANUAL"]);
  });

  it("list filters: unpaid, expiring in 7 days, and amount due", async () => {
    await unpaidShop(2, "List Unpaid");
    await liveShop(5, "List Seven");
    await liveShop(25, "List TwentyFive");
    const unpaid = await listShopRegistrations({ filter: "UNPAID" });
    expect(unpaid.rows.map((r) => r.shopName)).toEqual(["List Unpaid"]);
    expect(unpaid.rows[0].amountDuePaise).toBe(FEE);
    const seven = await listShopRegistrations({ filter: "EXPIRING_7" });
    expect(seven.rows.map((r) => r.shopName)).toEqual(["List Seven"]);
    expect(seven.counts.EXPIRING_30).toBe(2);
  });

  it("only admin / operator: a shop owner or customer is refused", async () => {
    const { shop } = await liveShop(5, "Roles");
    const operator = await createUser({ role: "OPERATOR" });
    await changeRegistrationExpiry(shop.id, { mode: "EXTEND", days: 1 }, "Operator extension", { id: operator.id, role: "OPERATOR" });
    for (const role of ["SHOP_OWNER", "CUSTOMER"] as const) {
      const u = await createUser({ role });
      await expect(changeRegistrationExpiry(shop.id, { mode: "EXTEND", days: 1 }, "Not allowed", { id: u.id, role })).rejects.toMatchObject({ status: 403 });
      await expect(markRegistrationPaid(shop.id, { reference: "X-1", note: "no", method: "CASH" }, { id: u.id, role })).rejects.toMatchObject({ status: 403 });
      await expect(sendRegistrationReminders([shop.id], { id: u.id, role })).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe("commission on renewals", () => {
  it("off by default: a renewal accrues no renewal commission", async () => {
    const { shop } = await liveShop(5, "No Commission");
    await recordPayment({ shopId: shop.id, paymentType: "RENEWAL", amountPaise: FEE }, admin);
    const rows = await db.execute(sql`select count(*)::int as n from audit_logs where entity_id = ${shop.id} and action like '%renewal_commission%'`);
    const n = Number(((Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as { n: number }[])[0]?.n ?? 0);
    expect(n).toBe(0);
  });
});

describe("migration of existing shops (0210)", () => {
  /** Runs the 0210 data statements again on fixture shops (the schema part is already applied). */
  async function runBackfill() {
    const file = readFileSync(path.join(process.cwd(), "drizzle/0210_shop_registration_subscription.sql"), "utf8");
    const statements = file
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => /^(--[^\n]*\n)*\s*(UPDATE|WITH|INSERT)/i.test(s));
    await db.delete(shopRegistrationMigrationReports);
    for (const s of statements) await db.execute(sql.raw(s));
  }

  it("paid → 1 year from the payment; never paid → UNPAID; past expiry → GRACE 7 days; report counts", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    // Paid before D-69 kept an end date: no expiry yet.
    const paid = await createShop(owner.id, { status: "APPROVED", registrationFeePaise: FEE, name: "Old Paid" });
    const paidAt = new Date(Date.now() - 100 * DAY);
    await recordPayment({ shopId: paid.id, paymentType: "REGISTRATION_FEE", amountPaise: FEE, paidAt }, admin);
    await db.update(shops).set({ membershipValidUntil: null, registrationStartDate: null, registrationStatusAt: null }).where(eq(shops.id, paid.id));
    // Paid long ago: the computed expiry is past.
    const old = await createShop(owner.id, { status: "APPROVED", registrationFeePaise: FEE, name: "Very Old" });
    await recordPayment({ shopId: old.id, paymentType: "REGISTRATION_FEE", amountPaise: FEE, paidAt: new Date(Date.now() - 400 * DAY) }, admin);
    await db.update(shops).set({ membershipValidUntil: null, registrationStartDate: null, registrationStatusAt: null }).where(eq(shops.id, old.id));
    // Never paid.
    const unpaid = await createShop(owner.id, { status: "PENDING_APPROVAL", registrationFeePaise: FEE, name: "Never Paid" });
    await db.update(shops).set({ registrationStatusAt: null }).where(eq(shops.id, unpaid.id));
    await db.execute(sql`delete from shop_membership_periods where shop_id in (${paid.id}, ${old.id})`);

    await runBackfill();

    const p = await shopRow(paid.id);
    expect(p.registrationStartDate?.getTime()).toBe(paidAt.getTime());
    expect(Math.abs(p.membershipValidUntil!.getTime() - (paidAt.getTime() + 365 * DAY))).toBeLessThan(2 * DAY);
    expect(p.registrationStatus).toBe("ACTIVE");
    expect(p.registrationBackfill).toBe("END_DATE_SET");
    const o = await shopRow(old.id);
    expect(o.registrationStatus).toBe("GRACE");
    expect(o.registrationGraceUntil!.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(o.registrationBackfill).toBe("END_DATE_SET,GRACE_GIVEN");
    expect((await shopRow(unpaid.id)).registrationStatus).toBe("UNPAID");
    // Still online during the migration grace.
    expect(await getPublicShopBySlug(o.slug)).toBeTruthy();

    const [report] = await db.select().from(shopRegistrationMigrationReports);
    expect(report.counts).toMatchObject({ UNPAID: 1, ACTIVE: 1, GRACE: 1, EXPIRED: 0 });
    expect(report.backfilled).toBe(2);
    expect(report.graced).toBe(1);
  });
});
