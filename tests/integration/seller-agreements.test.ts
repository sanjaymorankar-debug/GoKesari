/**
 * Seller agreements end to end (docs/seller-agreements-2026-11), against PostgreSQL and a real headless
 * Chromium (the PDF tests are skipped, loudly, where no Chromium can start):
 *
 * - publishing: documents stating different commission block each other (owner: 2 % for all); the medical
 *   agreement is executed by e-signature with no stamp paper; a translation needs its legal review and the English version first;
 * - an existing pharmacy must sign: grace period, licence blockers, OTP to the registered mobile;
 * - signing freezes one snapshot, prints every published language, records hashes that match the stored PDFs,
 *   writes immutable acceptance rows, e-mails the signed copies with CC, and satisfies the requirement;
 * - a licence change asks for re-confirmation (Annexure A); after the grace period no new orders;
 * - staff can only send the owner a link; the link resolves to the owner's shop.
 */
import { createHash } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ outbox: [] as { to: string; cc?: string[]; subject: string; attachments?: { filename: string; content: Buffer }[] }[] }));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; cc?: string[]; subject: string; attachments?: { filename: string; content: Buffer }[]; onSent?: (i: { messageId: string; mailbox: string }) => void }) => {
    state.outbox.push(message);
    message.onSent?.({ messageId: `<test-${state.outbox.length}@gokesari>`, mailbox: "test" });
  },
  EmailUnavailableError: class extends Error {},
}));

import { encryptSecret, decryptBytes } from "@/lib/pan-crypto";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  documentEmails,
  legalAcceptances,
  legalDocuments,
  legalShopAgreementStates,
  legalSignedFiles,
  outboundTestMessages,
  shopLegalDocuments,
  users,
  type User,
} from "@/server/db/schema";
import { deliverDocumentEmails } from "@/server/documents/email";
import { printHtmlToPdf } from "@/server/legal-agreements/pdf/html-to-pdf";
import { confirmReview, ensureBundledTemplates, publishChecks, publishTemplate, updateDraft } from "@/server/legal-agreements/registry";
import { assertAgreementsAllowOrders, getAgreementStatus } from "@/server/legal-agreements/requirements";
import { createSigningLink, resolveSigningLink, sendSigningCode, signAgreements } from "@/server/legal-agreements/signing";
import { clearFeatureFlagCache, setFeatureFlag } from "@/server/services/feature-flags";
import { clearRuleCache } from "@/server/services/settings";

import { createShop, createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";

let admin: User;
let pdfAvailable = true;

beforeAll(async () => {
  try {
    await printHtmlToPdf("<!doctype html><p>ok</p>", { letterhead: false });
  } catch (error) {
    // CI runs on Linux like gk-db-1: there the bundled Chromium must start, so fail instead of skipping.
    if (process.env.CI) throw error;
    pdfAvailable = false;
    console.warn("[seller-agreements test] Chromium could not start; PDF tests are SKIPPED:", error);
  }
}, 120_000);

afterAll(() => {
  clearFeatureFlagCache();
});

beforeEach(async () => {
  state.outbox = [];
  resetRateLimits();
  await resetDatabase();
  clearRuleCache();
  admin = await createUser({ role: "ADMIN" });
});

const actor = () => ({ id: admin.id, role: "ADMIN" });
const flag = (enabled: boolean) => setFeatureFlag("seller_agreements_enabled", { enabled, districtCodes: null }, "seller agreements test", { id: admin.id, role: "ADMIN", email: admin.email });

async function template(docType: "SELLER_SLA" | "MEDICAL_ONBOARDING", language: "en" | "mr" | "hi") {
  const [row] = await db.select().from(legalDocuments).where(and(eq(legalDocuments.docType, docType), eq(legalDocuments.language, language))).limit(1);
  return row;
}

/** Publishes SLA (en + mr) and the medical agreement (en), resolving the checks the way an admin would. */
async function publishAll() {
  await ensureBundledTemplates(admin.id);
  const medical = await template("MEDICAL_ONBOARDING", "en");
  await publishTemplate((await template("SELLER_SLA", "en")).id, actor(), { acknowledgeWarnings: true });
  await publishTemplate(medical.id, actor(), { acknowledgeWarnings: true });
  const mr = await template("SELLER_SLA", "mr");
  await confirmReview(mr.id, "translation", actor());
  await publishTemplate(mr.id, actor(), { acknowledgeWarnings: true });
}

async function pharmacyWithOwner(options: { drugLicence?: boolean } = {}) {
  const mobile = uniqueMobile();
  const owner = await createUser({ role: "SHOP_OWNER", mobile });
  await db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, owner.id));
  const shop = await createShop(owner.id, { shopType: "PHARMACY", name: "Agreement Test Pharmacy" });
  if (options.drugLicence !== false) {
    await db.insert(shopLegalDocuments).values({
      shopId: shop.id,
      docType: "DRUG_LICENCE",
      status: "SUBMITTED",
      numberEncrypted: encryptSecret("MH-PZ1-654321"),
      numberLast4: "4321",
      issuingCouncil: "FDA Maharashtra",
      expiryDate: "2030-03-31",
      submittedAt: new Date(),
    });
  }
  const [fresh] = await db.select().from(users).where(eq(users.id, owner.id));
  return { owner: fresh, shop, mobile: `+91${mobile}` };
}

async function lastSmsCode(e164: string): Promise<string> {
  const [row] = await db
    .select()
    .from(outboundTestMessages)
    .where(and(eq(outboundTestMessages.toAddress, e164), eq(outboundTestMessages.purpose, "otp")))
    .orderBy(desc(outboundTestMessages.createdAt))
    .limit(1);
  const code = row?.body.match(/(\d{4,8})/)?.[1];
  if (!code) throw new Error("no SMS code");
  return code;
}

describe("publishing", () => {
  it("TC-AGR-001 documents stating different commission block each other; the system never picks a value", async () => {
    await ensureBundledTemplates(admin.id);
    const sla = await template("SELLER_SLA", "en");
    // Owner decision 26-Nov-2026: 2 % for every shop — the bundled documents agree.
    expect((await publishChecks(sla.id)).blocking.join(" ")).not.toMatch(/Commission clash/);
    // A medical draft stating 3 % (as the original Word document did) blocks the SLA again.
    const medical = await template("MEDICAL_ONBOARDING", "en");
    await updateDraft(medical.id, { sourceValues: { ...medical.sourceValues, commissionPct: 3 } }, actor());
    const checks = await publishChecks(sla.id);
    expect(checks.blocking.join(" ")).toMatch(/Commission clash: .* states 2% .* states 3%/);
    await expect(publishTemplate(sla.id, actor(), { acknowledgeWarnings: true })).rejects.toThrow(/Commission clash/);
  });

  it("TC-AGR-002 the medical agreement is executed by e-signature: no stamp paper, no stamp-duty setting, nothing blocks it", async () => {
    await ensureBundledTemplates(admin.id);
    const medical = await template("MEDICAL_ONBOARDING", "en");
    expect(medical.templateBody).not.toMatch(/stamp paper of appropriate value|stampDuty/);
    expect(medical.templateBody).toContain("It is not executed on stamp paper.");
    expect(medical.reviewNotes).toEqual([]);
    expect((await publishChecks(medical.id)).blocking).toEqual([]);
  });

  it("TC-AGR-003 a translation waits for its legal review and for the English version", async () => {
    await ensureBundledTemplates(admin.id);
    const mr = await template("SELLER_SLA", "mr");
    expect(mr.reviewStatus).toBe("PENDING_LEGAL_REVIEW");
    const checks = await publishChecks(mr.id);
    expect(checks.blocking.join(" ")).toMatch(/pending legal review/);
    expect(checks.blocking.join(" ")).toMatch(/Publish the English version/);
  });
});

describe("signing", () => {
  it("TC-AGR-010 flag off: nothing is asked and nothing is blocked", async () => {
    await publishAll();
    const { shop } = await pharmacyWithOwner();
    const status = await getAgreementStatus(shop.id);
    expect(status.enabled).toBe(false);
    expect(status.required).toBe(false);
    await expect(assertAgreementsAllowOrders(shop.id)).resolves.toBeUndefined();
  });

  it("TC-AGR-011 a missing required licence blocks signing", async () => {
    await publishAll();
    await flag(true);
    const { owner, shop } = await pharmacyWithOwner({ drugLicence: false });
    const status = await getAgreementStatus(shop.id);
    expect(status.required).toBe(true);
    expect(status.blockers.join(" ")).toMatch(/Drug licence/i);
    await expect(sendSigningCode({ shopId: shop.id, owner }, null)).rejects.toThrow(/Before signing/);
  });

  it("TC-AGR-012 existing pharmacy: grace period, OTP signing, hashes, immutable record, e-mail with CC", async (ctx) => {
    if (!pdfAvailable) ctx.skip();
    await publishAll();
    await flag(true);
    const { owner, shop, mobile } = await pharmacyWithOwner();

    const status = await getAgreementStatus(shop.id);
    expect(status.required).toBe(true);
    expect(status.reason).toBe("EXISTING_SHOP");
    expect(status.documents.map((d) => d.docType).sort()).toEqual(["MEDICAL_ONBOARDING", "SELLER_SLA"]);
    expect(status.documents.find((d) => d.docType === "SELLER_SLA")!.languages).toEqual(["en", "mr"]);
    const grace = new Date(status.graceUntil!).getTime() - Date.now();
    expect(grace).toBeGreaterThan(6.9 * 86_400_000);

    // A wrong code changes nothing; the right one signs.
    await sendSigningCode({ shopId: shop.id, owner }, "203.0.113.5");
    const code = await lastSmsCode(mobile);
    const input = {
      signerName: "Asha Test Owner",
      designation: "PROPRIETOR" as const,
      constitution: "PROPRIETORSHIP" as const,
      pharmacist: { name: "Ravi Pharmacist", registrationNumber: "MSPC-777" },
      accepted: status.documents.map((d) => ({ docType: d.docType, version: d.version })),
      languageViewed: "mr" as const,
      ip: "203.0.113.5",
      userAgent: "Mozilla/5.0 GoKesariApp/1.15.0 (android)",
      geo: null,
    };
    await expect(signAgreements({ shopId: shop.id, owner }, { ...input, code: code === "000000" ? "111111" : "000000" })).rejects.toThrow();
    const result = await signAgreements({ shopId: shop.id, owner }, { ...input, code });
    expect(result.documents).toHaveLength(2);

    const rows = await db.select().from(legalAcceptances).where(eq(legalAcceptances.shopId, shop.id));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.appPlatform).toBe("android");
      expect(row.signerName).toBe("Asha Test Owner");
      expect(row.otpVerificationRef).toBeTruthy();
      const files = await db.select().from(legalSignedFiles).where(eq(legalSignedFiles.acceptanceId, row.id));
      for (const f of files) {
        const data = decryptBytes(Buffer.from(f.dataEncrypted));
        expect(createHash("sha256").update(data).digest("hex")).toBe(f.sha256);
        const recorded = f.kind === "SIGNED" ? row.signedPdfHashes : row.certifiedPdfHashes;
        expect(recorded[f.language]).toBe(f.sha256);
        expect(data.subarray(0, 5).toString()).toBe("%PDF-");
        if (f.language === "mr" && f.kind === "SIGNED") expect(data.toString("latin1")).toMatch(/NotoSansDevanagari/);
      }
      const langs = row.docType === "SELLER_SLA" ? ["en", "mr"] : ["en"];
      expect(files.map((f) => f.language).sort()).toEqual([...langs, ...langs].sort());
    }

    // Immutable.
    const refusal = (p: Promise<unknown>) => p.then(() => "allowed", (e: { message?: string; cause?: { message?: string } }) => `${e.cause?.message ?? ""} ${e.message ?? ""}`);
    expect(await refusal(db.update(legalAcceptances).set({ signerName: "Someone else" }).where(eq(legalAcceptances.shopId, shop.id)))).toMatch(/immutable legal record/);
    expect(await refusal(db.delete(legalSignedFiles).where(eq(legalSignedFiles.shopId, shop.id)))).toMatch(/immutable legal record/);

    // Satisfied; orders allowed.
    const after = await getAgreementStatus(shop.id);
    expect(after.required).toBe(false);
    await expect(assertAgreementsAllowOrders(shop.id)).resolves.toBeUndefined();

    // The signed copy e-mail: CC, subject, PDFs attached.
    await deliverDocumentEmails();
    const mail = state.outbox.find((m) => m.subject.includes("your signed gokesari.com agreements"));
    expect(mail).toBeTruthy();
    expect(mail!.cc).toEqual(["ceo@agtci.com"]);
    expect(mail!.subject).toContain("आपले स्वाक्षरी केलेले करार");
    expect(mail!.attachments!.filter((a) => a.filename.endsWith(".pdf")).length).toBe(3);
    const [sent] = await db.select().from(documentEmails).where(eq(documentEmails.docType, "SELLER_AGREEMENTS"));
    expect(sent.status).toBe("SENT");
    expect(sent.messageId).toMatch(/^<test-/);

    // A licence added later asks for re-confirmation of Annexure A.
    await db.insert(shopLegalDocuments).values({ shopId: shop.id, docType: "FSSAI", status: "SUBMITTED", numberEncrypted: encryptSecret("11526999000123"), numberLast4: "0123", expiryDate: "2031-01-01", submittedAt: new Date() });
    const changed = await getAgreementStatus(shop.id);
    expect(changed.required).toBe(true);
    expect(changed.reason).toBe("ANNEXURE_UPDATE");
  }, 240_000);

  it("TC-AGR-013 after the grace period the shop takes no new orders", async () => {
    await publishAll();
    await flag(true);
    const { shop } = await pharmacyWithOwner();
    await getAgreementStatus(shop.id);
    await db.update(legalShopAgreementStates).set({ graceUntil: new Date(Date.now() - 60_000) }).where(eq(legalShopAgreementStates.shopId, shop.id));
    await expect(assertAgreementsAllowOrders(shop.id)).rejects.toThrow(/can't accept new orders until the owner signs/);
    expect((await getAgreementStatus(shop.id)).overdue).toBe(true);
  });

  it("TC-AGR-014 staff send the owner a link; it resolves to the owner's shop; a new link cancels the old one", async () => {
    await publishAll();
    await flag(true);
    const { owner, shop } = await pharmacyWithOwner();
    const first = await createSigningLink(shop.id, actor(), "ADMIN");
    const second = await createSigningLink(shop.id, actor(), "ADMIN");
    const token = (url: string) => url.split("/agreements/sign/")[1];
    await expect(resolveSigningLink(token(first.url))).rejects.toThrow(/expired or was already used/);
    const link = await resolveSigningLink(token(second.url));
    expect(link.shopId).toBe(shop.id);
    expect(link.owner.id).toBe(owner.id);
    await expect(createSigningLink(shop.id, { id: owner.id, role: "SHOP_OWNER" }, "DEALER")).rejects.toThrow(/You are the owner/);
  });
});
