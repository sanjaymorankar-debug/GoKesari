/**
 * Owner decisions of 28-Nov-2026 ~12.00 IST (migration 0232; rule supportEscalation). Real PostgreSQL.
 *
 * A. Go-live rule for onboarding v2 / v3 registrations: referral code + GST or PAN verified + every term accepted +
 *    the fee (gateway, or pay-later approved). Missing licences, an unverified mobile, a weak name match → still live
 *    (a review flag recorded). Held ONLY when another owner's shop has the same GSTIN / PAN; the same owner's never.
 * B. A held shop is decided by the code's franchisee (an unrelated franchisee is refused), an operator or an admin.
 * C. One escalation ladder for SHOP_REVIEW, FEE_PAY_LATER and NO_PRODUCTS_OR_SALES: franchisee → operator queue at
 *    7 days → admin team at 10, notifications + audit at each step, the resolution closes it (injected `now`).
 * v1 registrations and already-live shops are unchanged.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async () => {},
  EmailUnavailableError: class extends Error {},
}));

vi.mock("@/server/legal-agreements/pdf/html-to-pdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/legal-agreements/pdf/html-to-pdf")>();
  return {
    ...real,
    printHtmlToPdf: async () => {
      const doc = await PDFDocument.create();
      doc.addPage([200, 200]);
      return Buffer.from(await doc.save());
    },
  };
});

import { gstinCheckChar } from "@/lib/kyc/doc-formats";
import { resetRateLimits } from "@/server/api/rate-limit";
import { issueCode } from "@/server/dealers/codes";
import { db } from "@/server/db";
import {
  auditLogs,
  dealers,
  notifications,
  sellerVerifications,
  shopFeePayLater,
  shopRegistrationDrafts,
  shopReviewFlags,
  shops,
  supportEscalationEvents,
  supportEscalations,
  users,
} from "@/server/db/schema";
import { dualAuthInForce } from "@/server/dual-auth/policy";
import { setKycAdapterForTests } from "@/server/kyc";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { acceptV3EarlyAgreement } from "@/server/onboarding-v2/early-agreement";
import { prepareV2Agreement, startDraftFeeCheckout, startV2Draft } from "@/server/onboarding-v2/shop-flow";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { decidePayLater, requestShopFeePayLater } from "@/server/services/fee-pay-later";
import { decideGovAutoApproval } from "@/server/services/gov-auto-approval";
import { newReferralCode } from "@/server/services/referrals";
import { clearRuleCache, setRule } from "@/server/services/settings";
import {
  decideEscalatedPayLater,
  decideHeldShop,
  levelDue,
  listEscalations,
  listOpenReviewFlags,
  runSupportEscalations,
} from "@/server/services/support-escalations";
import { submitDraftGstin, submitDraftPan } from "@/server/services/shop-registration-draft";
import { answerDraftReferral, getWizardDraft, saveDraftAddress, saveDraftLocation, saveDraftOwner, saveDraftShopType } from "@/server/services/shop-registration-wizard";
import { createCategory, createOrder, createProduct, createShop, createShopProduct, createUser, resetDatabase, uniqueMobile, verifySellerDocuments } from "../helpers/fixtures";

const DAY = 86_400_000;
const gstinFor = (pan: string) => {
  const first14 = `27${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};
const COMPANY_PAN = "AABCG1234K";
/** The mock KYC adapter: a number ending 7777 comes back under another name ("MISMATCHED NAME ENTERPRISES"). */
const WEAK_NAME_PAN = "ABCPT7777K";

type Owner = { id: string; role: "CUSTOMER"; email: string };
let admin: { id: string; role: "ADMIN" };
let operator: { id: string; role: "OPERATOR" };
let owner: Owner;

async function verifiedCustomer(): Promise<Owner> {
  const u = await createUser({ role: "CUSTOMER" });
  await db.update(users).set({ emailVerified: new Date(), phoneVerifiedAt: new Date() }).where(eq(users.id, u.id));
  return { id: u.id, role: "CUSTOMER", email: u.email };
}

async function franchisee(name: string) {
  const user = await createUser({ role: "DEALER", name });
  const [dealer] = await db
    .insert(dealers)
    .values({ userId: user.id, legalName: name, contactName: name, dealerType: "PROPRIETORSHIP", status: "APPROVED", mobileE164: `+91${uniqueMobile()}`, decidedAt: new Date() })
    .returning();
  const issued = await db.transaction((tx) => issueCode(tx, { dealerId: dealer.id, kind: "DEALER", makeCode: newReferralCode, label: name }, { id: admin.id, role: "ADMIN" }));
  return { user, actor: { id: user.id, role: "DEALER" as const }, dealer, code: issued.code, referralCodeId: issued.dealerCode.referralCodeId };
}

beforeEach(async () => {
  resetRateLimits();
  clearRuleCache();
  await resetDatabase();
  setKycAdapterForTests(createMockAdapter());
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  operator = { id: (await createUser({ role: "OPERATOR" })).id, role: "OPERATOR" };
  await setFeatureFlag("onboarding_v2", { enabled: true, districtCodes: null }, "go-live test", admin);
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "go-live test", admin);
  await setFeatureFlag("shop_fee_pay_later_enabled", { enabled: true, districtCodes: null }, "go-live test", admin);
  owner = await verifiedCustomer();
});
afterEach(() => {
  setKycAdapterForTests(null);
  vi.unstubAllGlobals();
});

const shopRow = async (id: string) => (await db.select().from(shops).where(eq(shops.id, id)))[0];
const escalationsOf = async (subjectId: string) => db.select().from(supportEscalations).where(eq(supportEscalations.subjectId, subjectId)).orderBy(asc(supportEscalations.openedAt));
const eventsOf = async (escalationId: string) => db.select().from(supportEscalationEvents).where(eq(supportEscalationEvents.escalationId, escalationId)).orderBy(asc(supportEscalationEvents.createdAt));
const noticesTo = async (userId: string, type: string) => db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));

/**
 * Another account's shop with the same GSTIN, appearing after the owner's GSTIN step (the step itself refuses a GSTIN
 * another account already has, so a hold is the safety net for a registration that overlaps another one).
 */
async function strangerWithSameGstin(pan = COMPANY_PAN) {
  const stranger = await createUser({ role: "SHOP_OWNER" });
  const theirs = await createShop(stranger.id, { status: "APPROVED", name: "Someone Else Mart" });
  await db.update(shops).set({ gstin: gstinFor(pan) }).where(eq(shops.id, theirs.id));
  return theirs;
}

async function acceptEarly(who: Owner) {
  const v = (await getWizardDraft(who))!;
  return acceptV3EarlyAgreement(who, {
    signerName: "Asha Signer",
    accepted: (v.v2?.early?.documents ?? []).map((d) => ({ docType: d.docType, version: d.version })),
    acceptPolicies: true,
    acceptUndertaking: true,
    acceptLicencePromise: true,
    ip: "203.0.113.9",
    userAgent: "go-live test",
  });
}

/**
 * The v3 order up to the last screen: referral, early agreement, GST (or PAN only), owner, fee through the sandbox
 * gateway, type, address + pin. `beforeCreate` runs just before the shop is created.
 */
async function registerV3(who: Owner, options: { referralCode?: string | null; pan?: string; gstPan?: string; shopType?: string; beforeCreate?: () => Promise<void> } = {}) {
  await startV2Draft(who);
  await answerDraftReferral({ actor: who, referralCode: options.referralCode ?? null });
  await acceptEarly(who);
  if (options.pan) await submitDraftPan({ pan: options.pan, declarationAccepted: true, consentGiven: true, actor: who });
  else await submitDraftGstin({ gstin: gstinFor(options.gstPan ?? COMPANY_PAN), consentGiven: true, actor: who });
  await saveDraftOwner({ actor: who, ownerName: "Test Seller" });
  const started = await startDraftFeeCheckout(who, { slab: 1, shopName: "Golive Mart" });
  await simulateSandboxCheckout({ ref: started.intentId!, viewerId: who.id, outcome: "SUCCESS" });
  await saveDraftShopType({ actor: who, shopType: options.shopType ?? "GROCERY_KIRANA" });
  await saveDraftAddress({
    actor: who,
    address: { addressLine1: "Shop No 7, Market Yard", addressLine2: null, area: "Gultekdi", city: "Pune", state: "Maharashtra", pincode: "411037", landmark: null },
  });
  await saveDraftLocation({ actor: who, latitude: 18.4869, longitude: 73.8655 });
  await options.beforeCreate?.();
  const done = await prepareV2Agreement(who, { ip: "198.51.100.1" });
  return done.shop!.id;
}

describe("A. go-live rule (v2 / v3 registrations)", () => {
  it("GL-01 live with only referral + verified PAN + agreement + fee: licences missing, mobile unverified, weak name match → live, flag recorded", async () => {
    await setRule("documentUpload", { fssaiMandatoryForFood: true }, admin);
    const shopId = await registerV3(owner, {
      pan: WEAK_NAME_PAN,
      beforeCreate: async () => {
        // Dual-auth in force and the owner's mobile no longer verified: a v1 shop would wait for it.
        await setFeatureFlag("dual_auth", { enabled: true, districtCodes: null }, "go-live test", admin);
        await db.update(users).set({ phoneVerifiedAt: null }).where(eq(users.id, owner.id));
      },
    });
    expect(await dualAuthInForce()).toBe(true);
    const shop = await shopRow(shopId);
    expect(shop.status).toBe("APPROVED");
    // The PAN the source verified stays VERIFIED despite the weak name; the licences are promised (follow-up).
    const [pan] = await db.select().from(sellerVerifications).where(and(eq(sellerVerifications.shopId, shopId), eq(sellerVerifications.docType, "PAN")));
    expect(pan.status).toBe("VERIFIED");
    expect(shop.documentsPromisedAt).not.toBeNull();
    const flags = await listOpenReviewFlags();
    expect(flags.map((f) => [f.shopId, f.flag])).toEqual([[shopId, "NAME_MATCH_LOW"]]);
    const raised = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, shopId), eq(auditLogs.action, "shop.review_flag_raised")));
    expect(raised).toHaveLength(1);
    // Nothing held, nothing escalated.
    expect(await escalationsOf(shopId)).toHaveLength(0);
  }, 180_000);

  it("GL-02 held only for another owner's shop with the same GSTIN; the same owner's shop with that GSTIN is not a hold", async () => {
    const gstin = gstinFor(COMPANY_PAN);
    // Same owner, other live shop with the same GSTIN: not held.
    const own = await registerV3(owner, {
      beforeCreate: async () => {
        const mine = await createShop(owner.id, { status: "APPROVED", name: "My First Branch" });
        await db.update(shops).set({ gstin }).where(eq(shops.id, mine.id));
      },
    });
    expect((await shopRow(own)).status).toBe("APPROVED");

    // Another owner's shop with the same GSTIN: held, SHOP_REVIEW opened (no franchisee → operator queue).
    const second = await verifiedCustomer();
    const held = await registerV3(second, { gstPan: "AABCH5678L", beforeCreate: async () => void (await strangerWithSameGstin("AABCH5678L")) });
    expect((await shopRow(held)).status).toBe("PENDING_APPROVAL");
    const [esc] = await escalationsOf(held);
    expect(esc).toMatchObject({ kind: "SHOP_REVIEW", level: "OPERATOR", franchiseeUserId: null, resolvedAt: null });
    expect(esc.reason).toMatch(/GSTIN/);
    // The operator is told (in-app + e-mail queued), the owner is reminded.
    expect(await noticesTo(operator.id, "support.escalation_assigned")).toHaveLength(1);
    expect(await noticesTo(second.id, "shop.support_reminder")).toHaveLength(1);
  }, 240_000);

  it("GL-03 the code's franchisee approves the held shop; an unrelated franchisee is refused", async () => {
    const f = await franchisee("Pune Franchise");
    const other = await franchisee("Nashik Franchise");
    const held = await registerV3(owner, { referralCode: f.code, beforeCreate: async () => void (await strangerWithSameGstin()) });
    expect((await shopRow(held)).status).toBe("PENDING_APPROVAL");
    const [esc] = await escalationsOf(held);
    expect(esc).toMatchObject({ kind: "SHOP_REVIEW", level: "FRANCHISEE", franchiseeUserId: f.user.id });
    expect(await noticesTo(f.user.id, "support.escalation_assigned")).toHaveLength(1);
    // The franchisee's own list shows it; the other franchisee's does not.
    expect((await listEscalations({ franchiseeUserId: f.user.id })).map((r) => r.id)).toEqual([esc.id]);
    expect(await listEscalations({ franchiseeUserId: other.user.id })).toHaveLength(0);

    await expect(decideHeldShop(esc.id, "APPROVE", null, other.actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideHeldShop(esc.id, "REJECT", " ", f.actor)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const decided = await decideHeldShop(esc.id, "APPROVE", "Spoke to both owners: separate businesses", f.actor);
    expect(decided.shop.status).toBe("APPROVED");
    expect(decided.escalation).toMatchObject({ resolution: "APPROVED", resolvedBy: f.user.id, resolutionNote: "Spoke to both owners: separate businesses" });
    const closed = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, held), eq(auditLogs.action, "support_escalation.resolved")));
    expect(closed).toHaveLength(1);
  }, 240_000);
});

describe("C. escalation ladder", () => {
  it("ES-00 the ladder: franchisee until day 7, operator until day 10, then admin; never back down", () => {
    const opened = new Date("2026-11-28T06:30:00Z");
    const rule = { franchiseeDays: 7, adminDays: 10 };
    expect(levelDue("FRANCHISEE", opened, new Date(opened.getTime() + 6.9 * DAY), rule)).toBe("FRANCHISEE");
    expect(levelDue("FRANCHISEE", opened, new Date(opened.getTime() + 7 * DAY), rule)).toBe("OPERATOR");
    expect(levelDue("OPERATOR", opened, new Date(opened.getTime() + 9 * DAY), rule)).toBe("OPERATOR");
    expect(levelDue("FRANCHISEE", opened, new Date(opened.getTime() + 10 * DAY), rule)).toBe("ADMIN");
    expect(levelDue("ADMIN", opened, new Date(opened.getTime() + 1 * DAY), rule)).toBe("ADMIN");
  });

  it("ES-01 SHOP_REVIEW: franchisee → operator at 7 days → admin at 10, told + audited at each step; the admin's rejection closes it", async () => {
    const f = await franchisee("Pune Franchise");
    const second = owner;
    const held = await registerV3(second, { referralCode: f.code, beforeCreate: async () => void (await strangerWithSameGstin()) });
    const [esc] = await escalationsOf(held);
    const t0 = esc.openedAt.getTime();

    await runSupportEscalations(new Date(t0 + 6 * DAY));
    expect((await escalationsOf(held))[0].level).toBe("FRANCHISEE");
    await runSupportEscalations(new Date(t0 + 7 * DAY + 60_000));
    expect((await escalationsOf(held))[0].level).toBe("OPERATOR");
    expect(await noticesTo(operator.id, "support.escalation_assigned")).toHaveLength(1);
    expect(await noticesTo(second.id, "shop.support_reminder")).toHaveLength(2);
    // Run again the same day: nothing new.
    await runSupportEscalations(new Date(t0 + 7 * DAY + 120_000));
    expect(await noticesTo(operator.id, "support.escalation_assigned")).toHaveLength(1);
    await runSupportEscalations(new Date(t0 + 10 * DAY + 60_000));
    expect((await escalationsOf(held))[0].level).toBe("ADMIN");
    expect(await noticesTo(admin.id, "support.escalation_assigned")).toHaveLength(1);
    expect(await noticesTo(second.id, "shop.support_reminder")).toHaveLength(3);

    const events = await eventsOf(esc.id);
    expect(events.map((e) => [e.event, e.fromLevel, e.toLevel])).toEqual([
      ["OPENED", null, "FRANCHISEE"],
      ["ESCALATED", "FRANCHISEE", "OPERATOR"],
      ["ESCALATED", "OPERATOR", "ADMIN"],
    ]);
    const moved = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, held), eq(auditLogs.action, "support_escalation.escalated"))).orderBy(desc(auditLogs.createdAt));
    expect(moved).toHaveLength(2);

    // The franchisee may still act after it moved on (DEFAULT); here the admin rejects with a reason.
    const rejected = await decideHeldShop(esc.id, "REJECT", "Same business registered twice", admin);
    expect(rejected.shop.status).toBe("REJECTED");
    expect(rejected.escalation).toMatchObject({ resolution: "REJECTED", resolvedBy: admin.id });
    expect((await eventsOf(esc.id)).find((e) => e.event === "RESOLVED")).toMatchObject({ fromLevel: "ADMIN", actorId: admin.id, note: "Same business registered twice" });
    // Closed: the job does not move it again.
    await runSupportEscalations(new Date(t0 + 30 * DAY));
    expect(await eventsOf(esc.id)).toHaveLength(4);
  }, 240_000);

  it("ES-02 FEE_PAY_LATER: the franchisee's request goes to the operators at 7 days, who may then decide; admin at 10", async () => {
    const f = await franchisee("Pune Franchise");
    const shopOwner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(shopOwner.id, { status: "PENDING_APPROVAL", registrationFeePaise: 118_000 });
    await db.update(shops).set({ referralCodeId: f.referralCodeId }).where(eq(shops.id, shop.id));
    await verifySellerDocuments(shop.id);
    const request = await requestShopFeePayLater(shop.id, { id: shopOwner.id });
    const [esc] = await escalationsOf(request.id);
    expect(esc).toMatchObject({ kind: "FEE_PAY_LATER", level: "FRANCHISEE", franchiseeUserId: f.user.id, shopId: shop.id });
    // While it is with the franchisee, the operator cannot decide it.
    await expect(decidePayLater(request.id, "APPROVE", null, operator)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideEscalatedPayLater(esc.id, "APPROVE", null, operator)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const t0 = esc.openedAt.getTime();
    await runSupportEscalations(new Date(t0 + 7 * DAY + 60_000));
    expect((await escalationsOf(request.id))[0].level).toBe("OPERATOR");
    expect(await noticesTo(operator.id, "support.escalation_assigned")).toHaveLength(1);
    expect(await noticesTo(shopOwner.id, "shop.support_reminder")).toHaveLength(1);

    // A second request (another shop) reaches the admin team at 10 days.
    const owner2 = await createUser({ role: "SHOP_OWNER" });
    const shop2 = await createShop(owner2.id, { status: "APPROVED", registrationFeePaise: 118_000 });
    await db.update(shops).set({ referralCodeId: f.referralCodeId }).where(eq(shops.id, shop2.id));
    const request2 = await requestShopFeePayLater(shop2.id, { id: owner2.id });
    const [esc2] = await escalationsOf(request2.id);
    await runSupportEscalations(new Date(esc2.openedAt.getTime() + 10 * DAY + 60_000));
    expect((await escalationsOf(request2.id))[0].level).toBe("ADMIN");
    // The first request, still open, is past 10 days too: both reached the admin team.
    expect((await escalationsOf(request.id))[0].level).toBe("ADMIN");
    expect(await noticesTo(admin.id, "support.escalation_assigned")).toHaveLength(2);

    // Escalated: the operator approves; the request and its escalation are closed.
    const decided = await decideEscalatedPayLater(esc.id, "APPROVE", "Owner called, will pay from sales", operator);
    expect(decided.request.status).toBe("APPROVED");
    expect((await escalationsOf(request.id))[0]).toMatchObject({ resolution: "APPROVED", resolvedBy: operator.id });
    const [row] = await db.select().from(shopFeePayLater).where(eq(shopFeePayLater.id, request.id));
    expect(row.decidedBy).toBe(operator.id);
  });

  it("ES-03 NO_PRODUCTS_OR_SALES: opened 10 days after go-live, reminders, operator at 7 more days; closed once products + a delivered order exist", async () => {
    const f = await franchisee("Pune Franchise");
    const shopId = await registerV3(owner, { referralCode: f.code });
    const live = await shopRow(shopId);
    expect(live.status).toBe("APPROVED");
    const goLive = live.approvedAt!.getTime();

    expect((await runSupportEscalations(new Date(goLive + 9 * DAY))).opened).toBe(0);
    await runSupportEscalations(new Date(goLive + 10 * DAY + 60_000));
    const [esc] = await escalationsOf(shopId);
    expect(esc).toMatchObject({ kind: "NO_PRODUCTS_OR_SALES", level: "FRANCHISEE", franchiseeUserId: f.user.id });
    expect(esc.reason).toMatch(/no products listed and no sale/);
    expect(await noticesTo(owner.id, "shop.support_reminder")).toHaveLength(1);
    expect(await noticesTo(f.user.id, "support.escalation_assigned")).toHaveLength(1);
    // Never a second one for the same shop.
    expect((await runSupportEscalations(new Date(goLive + 11 * DAY))).opened).toBe(0);

    await runSupportEscalations(new Date(esc.openedAt.getTime() + 7 * DAY + 60_000));
    expect((await escalationsOf(shopId))[0].level).toBe("OPERATOR");
    expect(await noticesTo(owner.id, "shop.support_reminder")).toHaveLength(2);

    // Products alone do not close it; products and a delivered order do.
    const category = await createCategory();
    const product = await createProduct(category.id);
    await createShopProduct(shopId, product.id);
    await runSupportEscalations(new Date(esc.openedAt.getTime() + 8 * DAY));
    expect((await escalationsOf(shopId))[0].resolvedAt).toBeNull();
    const customer = await createUser({ role: "CUSTOMER" });
    await createOrder(customer.id, shopId, { status: "DELIVERED" });
    const run = await runSupportEscalations(new Date(esc.openedAt.getTime() + 8 * DAY + 60_000));
    expect(run.resolved).toBe(1);
    expect((await escalationsOf(shopId))[0]).toMatchObject({ resolution: "RESOLVED" });
  }, 180_000);
});

describe("unchanged: v1 registrations and live shops", () => {
  it("UN-01 a live shop not from a v2 / v3 registration gets no no-sales escalation; a non-v2 shop's weak name match still holds it", async () => {
    const shopOwner = await createUser({ role: "SHOP_OWNER" });
    const old = await createShop(shopOwner.id, { status: "APPROVED" });
    await db.update(shops).set({ approvedAt: new Date(Date.now() - 60 * DAY) }).where(eq(shops.id, old.id));
    const run = await runSupportEscalations(new Date(Date.now() + 30 * DAY));
    expect(run.opened).toBe(0);
    expect(await escalationsOf(old.id)).toHaveLength(0);

    const pending = await createShop(shopOwner.id, { status: "PENDING_APPROVAL", registrationFeePaise: 0 });
    await db.update(shops).set({ panHash: "x-test-hash" }).where(eq(shops.id, pending.id));
    await verifySellerDocuments(pending.id);
    await db.update(sellerVerifications).set({ nameMatchScore: 40, providerId: "mock" }).where(and(eq(sellerVerifications.shopId, pending.id), eq(sellerVerifications.docType, "PAN")));
    const decision = await decideGovAutoApproval((await shopRow(pending.id))!);
    expect(decision.v2).toBeUndefined();
    expect(decision.reasons.join(" ")).toMatch(/name match 40 below/);
    expect(await db.select().from(shopReviewFlags)).toHaveLength(0);
    // A v1 registration draft is not a v2 one: the go-live rule above does not apply to it.
    expect(await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.flowVersion, "v2"))).toHaveLength(0);
  });
});
