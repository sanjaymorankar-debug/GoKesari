/**
 * Dealership & Franchise Platform phase 2 (docs/dealer-platform/PHASE_2_REGISTRATION.md), against real PostgreSQL
 * and the sandbox payment gateway:
 *   - only published dealership schemes are offered; a free scheme submits without paying
 *   - Business Partner: choose → pay ₹12,980 online (sandbox, through the real capture path) → submit with the terms
 *     fingerprint → approve → the dealer is on Business Partner v1 (REGISTRATION) with his acceptance on record
 *   - submit refused while unpaid, and when the terms changed under him
 *   - after paying, another scheme cannot be chosen
 *   - rejected → the joining charge is refunded through the gateway
 *   - acceptances cannot be changed or deleted
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as decisionPost } from "@/app/api/admin/dealers/[id]/decision/route";
import { PUT as appPut } from "@/app/api/dealer/application/route";
import { GET as schemeGet, POST as schemePost } from "@/app/api/dealer/application/scheme/route";
import { POST as payPost } from "@/app/api/dealer/application/scheme/pay/route";
import { POST as submitPost } from "@/app/api/dealer/application/submit/route";
import { DEALER_AGREEMENT_VERSION, type DealerDocType } from "@/lib/dealers";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { dealerDocuments, dealerJoiningPayments, paymentIntents, dealers, dealerSchemeAcceptances, dealerSchemes, dealerSchemeVersions } from "@/server/db/schema";
import { currentDealerScheme } from "@/server/dealers/schemes";
import { reviewDealerDocument, uploadDealerDocument } from "@/server/dealers/service";
import { getPaymentIntent } from "@/server/payments/intents";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { call } from "../helpers/http";
import { createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";
import { resetSchemes } from "../helpers/schemes";

type U = { id: string; email: string; name: string | null };
let admin: U;

function signIn(user: U, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const PDF = Buffer.from("%PDF-1.4\n% test document\n");

/** BP published (Free v1 for the "free only" case), Growth Partner a draft. */
async function seedState(publishBusinessPartner: boolean) {
  await resetSchemes(publishBusinessPartner ? ["FREE", "BUSINESS_PARTNER"] : ["FREE"], { freeVersion: 1 });
}

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`TRUNCATE TABLE payment_webhook_events, payment_refunds, payment_intent_events, payment_intents, payment_sandbox_orders CASCADE`);
  resetRateLimits();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name };
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", { id: a.id, role: "ADMIN" });
  await seedState(true);
});

async function applicant() {
  const u = await createUser();
  signIn(u, "CUSTOMER");
  const saved = await call(appPut, "/api/dealer/application", {
    method: "PUT",
    body: {
      legalName: "Shree Sai Distributors",
      contactName: "Sai Patil",
      dealerType: "PROPRIETORSHIP",
      mobile: uniqueMobile(),
      pan: "ABCPS1234K",
      gstin: null,
      addressLine1: "12 Laxmi Road",
      city: "Pune",
      pincode: "411030",
      territories: ["MH-PUN"],
      bank: { holderName: "Sai Patil", accountNumber: "026291800001191", ifsc: "YESB0000262" },
    },
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const [dealer] = await db.select().from(dealers).where(eq(dealers.userId, u.id));
  // Everything except the scheme ready to submit: documents uploaded, mobile verified.
  const required: DealerDocType[] = saved.body.dealer.requirements.filter((r: { required: boolean }) => r.required).map((r: { docType: DealerDocType }) => r.docType);
  for (const t of required) await uploadDealerDocument({ id: u.id, role: "CUSTOMER" }, t, { name: `${t}.pdf`, bytes: PDF });
  await db.update(dealers).set({ mobileVerifiedAt: new Date(), mobileVerificationMethod: "OTP" }).where(eq(dealers.id, dealer.id));
  return { user: u, dealer };
}

const schemes = () => call(schemeGet, "/api/dealer/application/scheme");
const choose = (versionId: string) => call(schemePost, "/api/dealer/application/scheme", { method: "POST", body: { versionId } });
const submit = (termsHash: string | null) => call(submitPost, "/api/dealer/application/submit", { method: "POST", body: { agreementVersion: DEALER_AGREEMENT_VERSION, termsHash } });

async function payAtSandbox(user: U) {
  const started = await call(payPost, "/api/dealer/application/scheme/pay", { method: "POST" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, started.body.intentId));
  await simulateSandboxCheckout({ ref: intent.merchantOrderId, viewerId: user.id, outcome: "SUCCESS", method: "UPI" });
  return started.body.intentId as string;
}

async function approve(dealerId: string) {
  for (const d of await db.select().from(dealerDocuments).where(eq(dealerDocuments.dealerId, dealerId))) await reviewDealerDocument(d.id, "ACCEPTED", null, { id: admin.id, role: "ADMIN" });
  signIn(admin, "ADMIN");
  return call(decisionPost, `/api/admin/dealers/${dealerId}/decision`, { method: "POST", params: { id: dealerId }, body: { action: "APPROVE", agreementStart: "2026-11-23", agreementEnd: "2027-11-22", bankVerifiedByDocument: true } });
}

describe("registration by scheme (phase 2)", () => {
  it("offers only published dealership schemes; Free submits without paying", async () => {
    await seedState(false);
    const { dealer } = await applicant();
    const list = await schemes();
    expect(list.body.schemes.map((s: { code: string }) => s.code)).toEqual(["FREE"]);
    expect(list.body.chosenVersionId).toBe(list.body.schemes[0].versionId);
    expect(list.body.charge).toMatchObject({ required: false, totalPaise: 0 });
    const res = await submit(list.body.schemes[0].termsHash);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [acc] = await db.select().from(dealerSchemeAcceptances).where(eq(dealerSchemeAcceptances.dealerId, dealer.id));
    expect(acc).toMatchObject({ context: "APPLICATION", termsHash: list.body.schemes[0].termsHash });
  });

  it("Business Partner: pay online, submit, approve → on Business Partner v1 with his acceptance", async () => {
    const { user, dealer } = await applicant();
    const list = await schemes();
    const bp = list.body.schemes.find((s: { code: string }) => s.code === "BUSINESS_PARTNER");
    expect(bp.totals).toEqual({ basePaise: 1_100_000, gstPaise: 198_000, totalPaise: 1_298_000 });
    const chosen = await choose(bp.versionId);
    expect(chosen.body.charge).toMatchObject({ required: true, totalPaise: 1_298_000, status: null });

    // Not paid: submit refused.
    const early = await submit(bp.termsHash);
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/Pay the joining charge/);

    const intentId = await payAtSandbox(user);
    const [paid] = await db.select().from(dealerJoiningPayments).where(eq(dealerJoiningPayments.dealerId, dealer.id));
    expect(paid).toMatchObject({ status: "PAID", totalPaise: 1_298_000, gstPaise: 198_000, paymentIntentId: intentId });
    expect((await getPaymentIntent(intentId))?.purpose).toBe("DEALER_JOINING_FEE");

    // Paid: another scheme can no longer be chosen; a second payment is refused.
    const free = list.body.schemes.find((s: { code: string }) => s.code === "FREE");
    expect((await choose(free.versionId)).status).toBe(409);
    expect((await call(payPost, "/api/dealer/application/scheme/pay", { method: "POST" })).status).toBe(409);

    // Terms he did not see: refused. The right fingerprint: submitted.
    expect((await submit("0".repeat(64))).status).toBe(409);
    const ok = await submit(bp.termsHash);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const approved = await approve(dealer.id);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const scheme = await currentDealerScheme(dealer.id);
    expect(scheme).toMatchObject({ schemeCode: "BUSINESS_PARTNER", version: 1, source: "REGISTRATION", termsHash: bp.termsHash });
  });

  it("refunds the joining charge through the gateway when the application is rejected", async () => {
    const { user, dealer } = await applicant();
    const bp = (await schemes()).body.schemes.find((s: { code: string }) => s.code === "BUSINESS_PARTNER");
    await choose(bp.versionId);
    const intentId = await payAtSandbox(user);
    expect((await submit(bp.termsHash)).status).toBe(200);
    signIn(admin, "ADMIN");
    const rejected = await call(decisionPost, `/api/admin/dealers/${dealer.id}/decision`, { method: "POST", params: { id: dealer.id }, body: { action: "REJECT", reason: "Documents do not match" } });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const [row] = await db.select().from(dealerJoiningPayments).where(eq(dealerJoiningPayments.dealerId, dealer.id));
    expect(["REFUNDED", "REFUND_PENDING"]).toContain(row.status);
    expect(row.refundId).not.toBeNull();
    expect(row.refundReason).toBe("Documents do not match");
    expect((await getPaymentIntent(intentId))?.status).toMatch(/REFUND/);
  });

  it("keeps acceptances unchangeable", async () => {
    const { dealer } = await applicant();
    const free = (await schemes()).body.schemes.find((s: { code: string }) => s.code === "FREE");
    expect((await submit(free.termsHash)).status).toBe(200);
    await expect(db.update(dealerSchemeAcceptances).set({ ipAddress: "1.2.3.4" }).where(eq(dealerSchemeAcceptances.dealerId, dealer.id))).rejects.toThrow();
    await expect(db.delete(dealerSchemeAcceptances).where(eq(dealerSchemeAcceptances.dealerId, dealer.id))).rejects.toThrow();
  });

  it("does not offer a draft scheme even if asked for it directly", async () => {
    await applicant();
    const [gp] = await db.select({ id: dealerSchemeVersions.id }).from(dealerSchemeVersions).innerJoin(dealerSchemes, eq(dealerSchemes.id, dealerSchemeVersions.schemeId)).where(and(eq(dealerSchemes.code, "GROWTH_PARTNER"), eq(dealerSchemeVersions.version, 1)));
    expect((await choose(gp.id)).status).toBe(422);
  });
});
