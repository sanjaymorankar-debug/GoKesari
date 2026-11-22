/**
 * Dealer documents checked online instead of uploaded (owner, 22-Nov-2026;
 * docs/dealer-programme/ONLINE_VERIFICATION.md). KYC_PROVIDER is the mock in tests: the PAN's four digits pick
 * the outcome (…7777 name mismatch, …0000 not found, …9999 vendor down; anything else verified).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as decisionPost } from "@/app/api/admin/dealers/[id]/decision/route";
import { PUT as appPut } from "@/app/api/dealer/application/route";
import { POST as submitPost } from "@/app/api/dealer/application/submit/route";
import { POST as verifyPost } from "@/app/api/dealer/application/verify/route";
import { DEALER_AGREEMENT_VERSION, type DealerDocType } from "@/lib/dealers";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { auditLogs, dealerDocuments, dealers, dealerVerifications } from "@/server/db/schema";
import { reviewDealerDocument, uploadDealerDocument } from "@/server/dealers/service";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { call } from "../helpers/http";
import { createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";

type U = { id: string; email: string; name: string | null };
let admin: U;

function signIn(user: U, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const PDF = Buffer.from("%PDF-1.4\n% test document\n");

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name };
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", { id: a.id, role: "ADMIN" });
});

function application(over: Record<string, unknown> = {}) {
  return {
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
    ...over,
  };
}

async function applicant(over: Record<string, unknown> = {}) {
  const u = await createUser();
  signIn(u, "CUSTOMER");
  const saved = await call(appPut, "/api/dealer/application", { method: "PUT", body: application(over) });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return u;
}

const verify = (target: "PAN" | "GSTIN" | "BANK") => call(verifyPost, "/api/dealer/application/verify", { method: "POST", body: { target } });
const statusOf = (body: { dealer: { requirements: { docType: DealerDocType; status: string }[] } }, t: DealerDocType) => body.dealer.requirements.find((r) => r.docType === t)?.status;

describe("documents verified online (owner 22-Nov-2026)", () => {
  it("a PAN verified online needs no upload; submit and approval count it as accepted", async () => {
    const u = await applicant();
    const res = await verify("PAN");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.status).toBe("VERIFIED");
    expect(statusOf(res.body, "PAN")).toBe("VERIFIED_ONLINE");
    const [row] = await db.select().from(dealerVerifications);
    expect(row).toMatchObject({ docType: "PAN", status: "VERIFIED", provider: "mock" });
    expect(row.nameScore).toBeGreaterThanOrEqual(85);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "dealer.document_checked_online"))).toHaveLength(1);

    // Upload every other required document; PAN is not uploaded.
    const [dealer] = await db.select().from(dealers).where(eq(dealers.userId, u.id));
    const required: DealerDocType[] = res.body.dealer.requirements.filter((r: { required: boolean; status: string }) => r.required && r.status === "MISSING").map((r: { docType: DealerDocType }) => r.docType);
    expect(required).not.toContain("PAN");
    for (const t of required) await uploadDealerDocument({ id: u.id, role: "CUSTOMER" }, t, { name: `${t}.pdf`, bytes: PDF });
    await db.update(dealers).set({ mobileVerifiedAt: new Date(), mobileVerificationMethod: "OTP" }).where(eq(dealers.id, dealer.id));
    const submitted = await call(submitPost, "/api/dealer/application/submit", { method: "POST", body: { agreementVersion: DEALER_AGREEMENT_VERSION } });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    for (const d of await db.select().from(dealerDocuments).where(eq(dealerDocuments.dealerId, dealer.id))) await reviewDealerDocument(d.id, "ACCEPTED", null, { id: admin.id, role: "ADMIN" });
    signIn(admin, "ADMIN");
    const approved = await call(decisionPost, `/api/admin/dealers/${dealer.id}/decision`, {
      method: "POST",
      params: { id: dealer.id },
      body: { action: "APPROVE", agreementStart: "2026-11-22", agreementEnd: "2027-11-21", bankVerifiedByDocument: true },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  });

  it("a GSTIN verified online also stands in for the address proof", async () => {
    await applicant({ gstin: "27ABCPS1234K1Z5" });
    const res = await verify("GSTIN");
    expect(res.body.result.status).toBe("VERIFIED");
    expect(statusOf(res.body, "GSTIN")).toBe("VERIFIED_ONLINE");
    expect(statusOf(res.body, "ADDRESS_PROOF")).toBe("VERIFIED_ONLINE");
  });

  it("a name that does not match, an unknown number or a vendor outage leaves the upload required", async () => {
    await applicant({ pan: "ABCPS7777K" });
    const mismatch = await verify("PAN");
    expect(mismatch.body.result.status).toBe("NAME_MISMATCH");
    expect(statusOf(mismatch.body, "PAN")).toBe("MISSING");
    expect(mismatch.body.dealer.onlineChecks).toEqual([expect.objectContaining({ docType: "PAN", status: "NAME_MISMATCH", current: true })]);

    await applicant({ pan: "ABCPS0000K" });
    expect((await verify("PAN")).body.result.status).toBe("FAILED");

    await applicant({ pan: "ABCPS9999K" });
    const down = await verify("PAN");
    expect(down.body.result.status).toBe("PENDING");
    expect(statusOf(down.body, "PAN")).toBe("MISSING");
  });

  it("a check counts only for the number it was made for; there must be a number to check", async () => {
    await applicant();
    expect((await verify("GSTIN")).status).toBe(422);
    expect((await verify("PAN")).body.result.status).toBe("VERIFIED");
    // Already verified: no second vendor call.
    expect((await verify("PAN")).body.result.message).toMatch(/already verified/);
    const changed = await call(appPut, "/api/dealer/application", { method: "PUT", body: application({ pan: "ABCPS4321K", mobile: null }) });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(statusOf(changed.body, "PAN")).toBe("MISSING");
    expect(changed.body.dealer.onlineChecks[0].current).toBe(false);
  });

  it("checks are limited per user", async () => {
    await applicant({ pan: "ABCPS9999K" });
    for (let i = 0; i < 10; i += 1) expect((await verify("PAN")).status).toBe(200);
    expect((await verify("PAN")).status).toBe(429);
  });
});
