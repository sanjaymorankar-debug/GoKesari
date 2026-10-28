/**
 * Onboarding wizard step 1 (docs/shop-onboarding-wizard-2026-10): the owner's
 * registration in progress, GSTIN first.
 *
 * GSTIN verified → the PAN inside it is checked with the government in the
 * background (the owner types nothing more) → both VERIFIED, and the shop's
 * name, legal name and address come from the GST record. Also: a proprietor's
 * PAN name becomes the owner name; not found / cancelled / another PAN's GSTIN
 * / PAN name mismatch; vendor outages on either check (the owner may go on);
 * no second paid call for a verified number or one in flight; an already
 * registered GSTIN is refused before any paid call; the hourly limit; the
 * PAN-only route with the "not GST-registered" declaration; one open draft per
 * owner, resumed and never shown to anyone else; numbers never stored in clear.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gstinCheckChar } from "@/lib/kyc/doc-formats";
import { db } from "@/server/db";
import { auditLogs, shopRegistrationDrafts, shops } from "@/server/db/schema";
import { KycUnavailableError, setKycAdapterForTests, type KycAdapter, type ProviderOutcome, type SourceRecord, type VerifyRequest } from "@/server/kyc";
import { getOpenDraft, submitDraftGstin, submitDraftPan } from "@/server/services/shop-registration-draft";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

/** A GSTIN with a valid check character: state 27, the given PAN, entity 1, Z. */
const gstinFor = (pan: string, state = "27") => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

const COMPANY_PAN = "AABCG1234K"; // 4th letter C: a company
const PROPRIETOR_PAN = "ABCPK5678L"; // 4th letter P: a person

let calls: VerifyRequest[] = [];
function scripted(answer: (req: VerifyRequest) => ProviderOutcome | Promise<ProviderOutcome>) {
  const adapter: KycAdapter = {
    id: "mock",
    verify: async (req) => {
      calls.push(req);
      return answer(req);
    },
  };
  setKycAdapterForTests(adapter);
}
const found = (record: Partial<SourceRecord>, ref = "gov-ref"): ProviderOutcome => ({
  kind: "found",
  providerRef: ref,
  record: { docStatus: "active", name: null, ...record },
});

/** The government answers for a company: GST legal + trade name and address; the PAN holder is the company. */
function companySource(overrides: { gst?: Partial<SourceRecord>; pan?: Partial<SourceRecord> } = {}) {
  scripted((req) =>
    req.docType === "GSTIN"
      ? found(
          {
            name: "GANESH RETAIL PRIVATE LIMITED",
            tradeName: "GANESH SUPER MART",
            linkedPan: req.number.slice(2, 12),
            entityType: "Private Limited Company",
            stateCode: "27",
            pincode: "411005",
            address: "12 FC Road, Shivajinagar, Pune, Maharashtra, 411005",
            ...overrides.gst,
          },
          "gst-ref-1",
        )
      : found({ name: "GANESH RETAIL PVT LTD", entityType: "C", ...overrides.pan }, "pan-ref-1"),
  );
}

let owner: { id: string; role: "CUSTOMER" };
beforeEach(async () => {
  await resetDatabase();
  calls = [];
  const u = await createUser({ role: "CUSTOMER" });
  owner = { id: u.id, role: "CUSTOMER" };
});
afterEach(() => setKycAdapterForTests(null));

const submitGstin = (gstin: string, actor = owner) => submitDraftGstin({ gstin, consentGiven: true, actor });
const draftRow = async (ownerId = owner.id) =>
  (await db.select().from(shopRegistrationDrafts).where(and(eq(shopRegistrationDrafts.ownerId, ownerId), eq(shopRegistrationDrafts.status, "OPEN"))))[0];

describe("GSTIN first: the PAN is checked silently and the shop is filled from the GST record", () => {
  it("verifies GSTIN and PAN with one owner input, and fills the shop's name, legal name and address", async () => {
    companySource();
    const gstin = gstinFor(COMPANY_PAN);
    const view = await submitGstin(gstin);

    // Two government calls: the GSTIN, then the PAN taken out of it.
    expect(calls.map((c) => [c.docType, c.number])).toEqual([
      ["GSTIN", gstin],
      ["PAN", COMPANY_PAN],
    ]);
    expect(view.route).toBe("GSTIN");
    expect(view.gstin).toMatchObject({ status: "VERIFIED", message: null });
    expect(view.pan).toMatchObject({ status: "VERIFIED", holderType: "Company" });
    expect(view.pan!.nameMatchScore).toBeGreaterThanOrEqual(85);
    expect(view.prefill).toEqual({
      shopName: "GANESH SUPER MART",
      legalName: "GANESH RETAIL PRIVATE LIMITED",
      tradeName: "GANESH SUPER MART",
      ownerName: null, // a company's PAN is not a person's
      constitution: "Private Limited Company",
      address: "12 FC Road, Shivajinagar, Pune, Maharashtra, 411005",
      stateCode: "27",
      pincode: "411005",
    });
    expect(view.canContinue).toBe(true);

    // Both results kept with the provider's references, for the approval evidence later.
    const row = await draftRow();
    expect(row).toMatchObject({ gstProviderRef: "gst-ref-1", panProviderRef: "pan-ref-1", gstProviderId: "mock", panProviderId: "mock" });
    expect(row.gstVerifiedAt).not.toBeNull();
    expect(row.panVerifiedAt).not.toBeNull();
  });

  it("never stores or shows a full number; the audit entry is masked", async () => {
    companySource();
    const gstin = gstinFor(COMPANY_PAN);
    const view = await submitGstin(gstin);
    const row = await draftRow();
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(gstin);
    expect(stored).not.toContain(COMPANY_PAN);
    expect(JSON.stringify(view)).not.toContain(COMPANY_PAN);
    expect(view.gstin!.numberMasked).not.toBe(gstin);

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "shop_registration_draft.checked"));
    expect(audit.entityId).toBe(row.id);
    expect(JSON.stringify(audit.newValue)).not.toContain(COMPANY_PAN);
    expect(audit.newValue).toMatchObject({ route: "GSTIN", gstStatus: "VERIFIED", panStatus: "VERIFIED" });
  });

  it("a proprietor: the GST legal name is the person on the PAN, who becomes the owner name", async () => {
    scripted((req) =>
      req.docType === "GSTIN"
        ? found({ name: "RAJESH KUMAR", tradeName: "RAJESH KIRANA STORE", linkedPan: req.number.slice(2, 12), entityType: "Proprietorship" })
        : found({ name: "RAJESH KUMAR", entityType: "P" }),
    );
    const view = await submitGstin(gstinFor(PROPRIETOR_PAN));
    expect(view.pan).toMatchObject({ status: "VERIFIED", holderType: "Individual" });
    expect(view.prefill).toMatchObject({ shopName: "RAJESH KIRANA STORE", legalName: "RAJESH KUMAR", ownerName: "RAJESH KUMAR" });
  });

  it("works against the built-in mock vendor used on staging", async () => {
    setKycAdapterForTests(null);
    const view = await submitGstin(gstinFor(PROPRIETOR_PAN));
    expect(view.gstin!.status).toBe("VERIFIED");
    expect(view.pan!.status).toBe("VERIFIED");
    expect(view.prefill.address).toContain("Pune");
    expect(view.canContinue).toBe(true);
  });
});

describe("GSTIN problems", () => {
  it("not found at source → FAILED with a message; the PAN is not checked; the owner cannot go on", async () => {
    scripted(() => ({ kind: "not_found", providerRef: "x" }));
    const view = await submitGstin(gstinFor(COMPANY_PAN));
    expect(calls.map((c) => c.docType)).toEqual(["GSTIN"]);
    expect(view.gstin).toMatchObject({ status: "FAILED", errorCode: "not_found_at_source" });
    expect(view.gstin!.message).toMatch(/not found/);
    expect(view.pan).toBeNull();
    expect(view.prefill.shopName).toBeNull();
    expect(view.canContinue).toBe(false);
  });

  it("cancelled GSTIN → FAILED, nothing filled in", async () => {
    companySource({ gst: { docStatus: "cancelled" } });
    const view = await submitGstin(gstinFor(COMPANY_PAN));
    expect(view.gstin).toMatchObject({ status: "FAILED", errorCode: "document_cancelled" });
    expect(view.prefill.address).toBeNull();
    expect(view.canContinue).toBe(false);
  });

  it("the record links the GSTIN to another PAN → review; no PAN check, nothing filled in, the owner may go on", async () => {
    companySource({ gst: { linkedPan: "ZZZCZ9999Z" } });
    const view = await submitGstin(gstinFor(COMPANY_PAN));
    expect(calls.map((c) => c.docType)).toEqual(["GSTIN"]);
    expect(view.gstin).toMatchObject({ status: "MANUAL_REVIEW", errorCode: "gstin_pan_mismatch" });
    expect(view.prefill.shopName).toBeNull();
    expect(view.canContinue).toBe(true);
  });

  it("a malformed GSTIN or missing consent costs no paid call", async () => {
    companySource();
    const good = gstinFor(COMPANY_PAN);
    await expect(submitGstin(good.slice(0, 14) + (good.endsWith("A") ? "B" : "A"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: false, actor: owner })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(calls).toEqual([]);
    expect(await draftRow()).toBeUndefined();
  });

  it("a GSTIN already registered to a live shop is refused before any paid call", async () => {
    companySource();
    const other = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(other.id, { status: "APPROVED" });
    const gstin = gstinFor(COMPANY_PAN);
    await db.update(shops).set({ gstin }).where(eq(shops.id, shop.id));
    await expect(submitGstin(gstin)).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "DUPLICATE_SHOP" } });
    expect(calls).toEqual([]);
  });

  it("a rejected shop's GSTIN may be registered again", async () => {
    companySource();
    const other = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(other.id, { status: "REJECTED" });
    const gstin = gstinFor(COMPANY_PAN);
    await db.update(shops).set({ gstin }).where(eq(shops.id, shop.id));
    expect((await submitGstin(gstin)).gstin!.status).toBe("VERIFIED");
  });
});

describe("PAN problems after a verified GSTIN", () => {
  it("the PAN holder's name differs from the GST names → PAN in review, the owner may go on", async () => {
    companySource({ pan: { name: "SOMEONE ELSE ENTIRELY" } });
    const view = await submitGstin(gstinFor(COMPANY_PAN));
    expect(view.gstin!.status).toBe("VERIFIED");
    expect(view.pan).toMatchObject({ status: "MANUAL_REVIEW", errorCode: "name_mismatch" });
    expect(view.pan!.nameMatchScore).toBeLessThan(85);
    expect(view.canContinue).toBe(true);
  });

  it("an inactive PAN → FAILED; the owner cannot go on", async () => {
    companySource({ pan: { docStatus: "inactive" } });
    const view = await submitGstin(gstinFor(COMPANY_PAN));
    expect(view.pan).toMatchObject({ status: "FAILED", errorCode: "document_inactive" });
    expect(view.canContinue).toBe(false);
  });
});

describe("vendor outages and repeat submissions", () => {
  it("GST source down → PENDING, the owner may go on; an immediate repeat joins it; a later one calls again", async () => {
    scripted(() => {
      throw new KycUnavailableError("timeout", "down");
    });
    const gstin = gstinFor(COMPANY_PAN);
    const first = await submitGstin(gstin);
    expect(first.gstin).toMatchObject({ status: "PENDING", errorCode: "vendor_timeout" });
    expect(first.gstin!.message).toMatch(/carry on/);
    expect(first.canContinue).toBe(true);

    await submitGstin(gstin); // within 30 s: rides on the first
    expect(calls).toHaveLength(1);

    // 31 s later the source is back.
    await db.update(shopRegistrationDrafts).set({ gstCheckedAt: new Date(Date.now() - 31_000) }).where(eq(shopRegistrationDrafts.ownerId, owner.id));
    companySource();
    const retried = await submitGstin(gstin);
    expect(retried.gstin!.status).toBe("VERIFIED");
    expect(retried.pan!.status).toBe("VERIFIED");
  });

  it("PAN source down after a verified GSTIN → PAN PENDING; resubmitting rechecks only the PAN", async () => {
    let panDown = true;
    scripted((req) => {
      if (req.docType === "PAN" && panDown) throw new KycUnavailableError("source_down", "PAN service down");
      return req.docType === "GSTIN"
        ? found({ name: "GANESH RETAIL PRIVATE LIMITED", linkedPan: req.number.slice(2, 12) })
        : found({ name: "GANESH RETAIL PRIVATE LIMITED" });
    });
    const gstin = gstinFor(COMPANY_PAN);
    const first = await submitGstin(gstin);
    expect(first.gstin!.status).toBe("VERIFIED");
    expect(first.pan!.status).toBe("PENDING");
    expect(first.canContinue).toBe(true);

    panDown = false;
    const second = await submitGstin(gstin);
    expect(second.pan!.status).toBe("VERIFIED");
    expect(calls.map((c) => c.docType)).toEqual(["GSTIN", "PAN", "PAN"]);
  });

  it("the same verified GSTIN again costs no paid call", async () => {
    companySource();
    const gstin = gstinFor(COMPANY_PAN);
    await submitGstin(gstin);
    const again = await submitGstin(gstin);
    expect(calls).toHaveLength(2);
    expect(again.gstin!.status).toBe("VERIFIED");
  });

  it("a different GSTIN replaces the first, and everything learned from it", async () => {
    companySource();
    await submitGstin(gstinFor(COMPANY_PAN));
    scripted(() => ({ kind: "not_found", providerRef: null }));
    const view = await submitGstin(gstinFor("AABCH4321M"));
    expect(view.gstin!.status).toBe("FAILED");
    expect(view.pan).toBeNull();
    expect(view.prefill.legalName).toBeNull();
  });

  it("holds the owner to the hourly limit of paid checks", async () => {
    scripted(() => ({ kind: "not_found", providerRef: null }));
    const pans = ["AABCA", "AABCB", "AABCD", "AABCE", "AABCF", "AABCH", "AABCJ", "AABCL", "AABCM", "AABCN", "AABCQ"].map((p) => `${p}1234K`);
    for (const pan of pans.slice(0, 10)) await submitGstin(gstinFor(pan));
    await expect(submitGstin(gstinFor(pans[10]))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(calls).toHaveLength(10);
  });
});

describe("no GSTIN: PAN with the declaration", () => {
  it("checks the PAN, records the declaration, and lets the owner go on", async () => {
    scripted(() => found({ name: "RAJESH KUMAR", entityType: "P" }));
    const view = await submitDraftPan({ pan: PROPRIETOR_PAN, declarationAccepted: true, consentGiven: true, actor: owner });
    expect(calls.map((c) => [c.docType, c.number])).toEqual([["PAN", PROPRIETOR_PAN]]);
    expect(view).toMatchObject({ route: "PAN_ONLY", noGstDeclared: true, gstin: null, canContinue: true });
    expect(view.pan).toMatchObject({ status: "VERIFIED", holderType: "Individual" });
    expect(view.prefill).toMatchObject({ ownerName: "RAJESH KUMAR", shopName: null, address: null });
    expect((await draftRow()).noGstDeclarationVersion).not.toBeNull();
  });

  it("refuses without the declaration", async () => {
    scripted(() => found({ name: "RAJESH KUMAR" }));
    await expect(
      submitDraftPan({ pan: PROPRIETOR_PAN, declarationAccepted: false, consentGiven: true, actor: owner }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(calls).toEqual([]);
  });

  it("switching from the GSTIN route drops the GSTIN and what it filled in, and checks this PAN afresh", async () => {
    companySource();
    await submitGstin(gstinFor(COMPANY_PAN));
    scripted(() => found({ name: "GANESH RETAIL PVT LTD" }));
    calls = [];
    const view = await submitDraftPan({ pan: COMPANY_PAN, declarationAccepted: true, consentGiven: true, actor: owner });
    expect(calls.map((c) => c.docType)).toEqual(["PAN"]);
    expect(view.gstin).toBeNull();
    expect(view.prefill.legalName).toBeNull();
    const row = await draftRow();
    expect(row.gstinEncrypted).toBeNull();
    expect(row.gstRecord).toEqual({});
  });
});

describe("one draft per owner, resumed", () => {
  it("returns the open draft to its owner only", async () => {
    companySource();
    expect(await getOpenDraft(owner)).toBeNull();
    await submitGstin(gstinFor(COMPANY_PAN));
    const resumed = await getOpenDraft(owner);
    expect(resumed).toMatchObject({ route: "GSTIN", canContinue: true });

    const stranger = await createUser({ role: "CUSTOMER" });
    expect(await getOpenDraft({ id: stranger.id, role: "CUSTOMER" })).toBeNull();
  });

  it("two tabs submitting at once make one draft", async () => {
    companySource();
    await Promise.all([submitGstin(gstinFor(COMPANY_PAN)), submitGstin(gstinFor(COMPANY_PAN))]);
    const rows = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.ownerId, owner.id));
    expect(rows).toHaveLength(1);
  });

  it("refuses a user that does not exist", async () => {
    companySource();
    await expect(submitGstin(gstinFor(COMPANY_PAN), { id: "00000000-0000-4000-8000-000000000000", role: "CUSTOMER" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
