/**
 * Owner rule (26-Nov-2026): a new shop gets ONE e-mail — the personalised welcome kit with its signed seller
 * agreements attached — not a "signed copy" mail plus a welcome mail (docs/shop-welcome-kit-2026-11,
 * docs/seller-agreements-2026-11). The signed files here are inserted directly (stand-in PDF bytes), so the
 * test needs no Chromium; seller-agreements.test.ts covers the real signing and PDFs.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({
  emails: [] as { to: string; cc?: string[]; subject: string; text: string; html?: string; attachments?: { filename: string; contentType: string; content: Buffer; cid?: string }[] }[],
}));
vi.mock("@/server/email/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email/transport")>();
  return {
    ...actual,
    emailMode: () => "smtp" as const,
    sendEmail: vi.fn(async (message: (typeof sent.emails)[number]) => {
      sent.emails.push(message);
    }),
  };
});

import { encryptBytes } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import { documentEmails, legalAcceptances, legalAgreementEmails, legalSignedFiles, legalSigningRequests, shops } from "@/server/db/schema";
import { deliverDocumentEmails } from "@/server/documents/email";
import { afterSigning, emailLogFor, onRegistrationFeePaid } from "@/server/legal-agreements/email";
import { queueBannerUpdate } from "@/server/shop-banner/welcome-kit";
import { recordPayment } from "@/server/services/shop-payments";
import { clearRuleCache, getRule, setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
  sent.emails.length = 0;
});

const KIT = "is now live on GoKesari.com";
const SIGNED_COPY = "your signed gokesari.com agreements";
/** The mails this rule is about (the fee also sends a receipt, which is not counted). */
const ours = () => sent.emails.filter((m) => m.subject.includes(KIT) || m.subject.includes(SIGNED_COPY) || m.subject.includes("updated GoKesari banners"));
const pdfs = (m: (typeof sent.emails)[number]) => (m.attachments ?? []).filter((a) => a.contentType === "application/pdf").map((a) => a.filename);

async function newShop() {
  const admin = await createUser({ role: "ADMIN" });
  await setRule("sellerVerification", { autoApproveShop: true }, { id: admin.id, role: "ADMIN" });
  const owner = await createUser({ role: "SHOP_OWNER", email: `owner-${Math.random().toString(36).slice(2)}@example.com` });
  const shop = await createShop(owner.id, { name: "Samarth Tea Center", status: "PENDING_APPROVAL", shopType: "HARDWARE_STORE", registrationFeePaise: 500_000 });
  await verifySellerDocuments(shop.id, ["PAN", "GSTIN", "SHOP_ACT"]);
  await db.update(shops).set({ ownerName: "SUNITA PATIL", state: "Maharashtra", pincode: "411007" }).where(eq(shops.id, shop.id));
  return { admin: { id: admin.id, role: "ADMIN" as const, email: admin.email, name: admin.name }, owner, shop };
}

/** A signed REGISTRATION request with the Seller SLA certified in English, Marathi and Hindi. */
async function signRegistration(shopId: string, ownerId: string, bytesPerFile = 2_000) {
  const [req] = await db.insert(legalSigningRequests).values({ shopId, ownerUserId: ownerId, reason: "REGISTRATION", status: "SIGNED", signedAt: new Date() }).returning();
  const [acc] = await db
    .insert(legalAcceptances)
    .values({
      signingRequestId: req.id,
      shopId,
      userId: ownerId,
      docType: "SELLER_SLA",
      version: "1.0",
      languageViewed: "en",
      acceptedAt: new Date(),
      appPlatform: "web",
      signerName: "Sunita Patil",
      signerDesignation: "PROPRIETOR",
      verifyCode: `T${randomUUID().slice(0, 8).toUpperCase()}`,
    })
    .returning();
  for (const language of ["en", "mr", "hi"] as const) {
    const doc = await PDFDocument.create();
    doc.addPage().drawText(`Seller SLA stand-in (${language})`);
    await doc.attach(randomBytes(bytesPerFile), "padding.bin", { mimeType: "application/octet-stream" }); // incompressible size
    const data = Buffer.from(await doc.save());
    await db.insert(legalSignedFiles).values({
      acceptanceId: acc.id,
      shopId,
      language,
      kind: "CERTIFIED",
      sha256: createHash("sha256").update(data).digest("hex"),
      sizeBytes: data.length,
      dataEncrypted: encryptBytes(data),
    });
  }
  return req.id;
}

const rows = (shopId: string, docType: string) => db.select().from(documentEmails).where(and(eq(documentEmails.docType, docType), eq(documentEmails.docId, shopId)));
/** The fee is recorded and the automatic-approval rule makes the shop live (which queues its welcome kit). */
async function goLive(shopId: string, admin: { id: string; role: "ADMIN" }) {
  await recordPayment({ shopId, paymentType: "REGISTRATION_FEE", amountPaise: 500_000 }, admin);
  const [row] = await db.select({ status: shops.status }).from(shops).where(eq(shops.id, shopId));
  expect(row.status).toBe("APPROVED");
}

const agreementRows = () => db.select().from(documentEmails).where(eq(documentEmails.docType, "SELLER_AGREEMENTS"));

describe("TC-WKIT-039 … 042: one e-mail for a new shop — the welcome kit carries the signed agreements", () => {
  it("TC-WKIT-039 signed, fee paid, live → exactly one e-mail: banners + the three signed PDFs, CC'd; logged in My Agreements", async () => {
    const { admin, owner, shop } = await newShop();
    const requestId = await signRegistration(shop.id, owner.id);
    await afterSigning({ shopId: shop.id, signingRequestId: requestId, reason: "REGISTRATION" }); // fee not paid yet: nothing
    await goLive(shop.id, admin);
    await onRegistrationFeePaid(shop.id);
    await onRegistrationFeePaid(shop.id); // a replayed capture adds nothing
    await deliverDocumentEmails();

    expect(ours()).toHaveLength(1);
    const [mail] = ours();
    expect(mail.to).toBe(owner.email);
    expect(mail.subject).toContain(KIT);
    expect(pdfs(mail)).toEqual(expect.arrayContaining(["seller-sla-v1.0-en-signed.pdf", "seller-sla-v1.0-mr-signed.pdf", "seller-sla-v1.0-hi-signed.pdf"]));
    expect(pdfs(mail).filter((f) => !f.includes("seller-sla"))).toHaveLength(2); // English + Marathi banners
    expect(mail.cc).toEqual((await getRule("sellerAgreements")).ccEmails);
    expect(mail.html).toContain("Your signed agreements");
    expect(mail.text).toContain("Dear Sunita Patil, congratulations!");
    expect(mail.text).toContain("Your signed agreements are attached");
    expect(await agreementRows()).toHaveLength(0);

    const log = await emailLogFor(requestId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: "SIGNED_COPY", status: "SENT", to: owner.email });
    expect(log[0].attachments.map((a) => a.filename)).toHaveLength(3);
  });

  it("TC-WKIT-040 live shop with no kit yet (approved before the release) → the fee hook queues the kit, which carries the PDFs", async () => {
    const { admin, owner, shop } = await newShop();
    await goLive(shop.id, admin);
    await db.delete(documentEmails).where(and(eq(documentEmails.docType, "SHOP_WELCOME_KIT"), eq(documentEmails.docId, shop.id))); // as if live before the release
    const requestId = await signRegistration(shop.id, owner.id);
    await afterSigning({ shopId: shop.id, signingRequestId: requestId, reason: "REGISTRATION" });
    await deliverDocumentEmails();
    expect(ours()).toHaveLength(1);
    expect(ours()[0].subject).toContain(KIT);
    expect(pdfs(ours()[0]).filter((f) => f.includes("seller-sla"))).toHaveLength(3);
    expect(await rows(shop.id, "SHOP_WELCOME_KIT")).toHaveLength(1);
  });

  it("TC-WKIT-041 the kit went out before the owner signed (staff registered the shop) → the signed copy follows alone, without banners; the banner update never carries agreements", async () => {
    const { admin, owner, shop } = await newShop();
    await goLive(shop.id, admin);
    await deliverDocumentEmails();
    expect(ours()).toHaveLength(1);
    expect(pdfs(ours()[0]).some((f) => f.includes("seller-sla"))).toBe(false);

    const requestId = await signRegistration(shop.id, owner.id);
    await afterSigning({ shopId: shop.id, signingRequestId: requestId, reason: "REGISTRATION" });
    await onRegistrationFeePaid(shop.id);
    await deliverDocumentEmails();
    const copies = sent.emails.filter((m) => m.subject.includes(SIGNED_COPY));
    expect(copies).toHaveLength(1);
    expect(pdfs(copies[0])).toHaveLength(3);
    expect(pdfs(copies[0]).every((f) => f.includes("seller-sla"))).toBe(true);
    const [log] = await db.select().from(legalAgreementEmails).where(eq(legalAgreementEmails.signingRequestId, requestId));
    expect(log.includeBanners).toBe(false);

    await queueBannerUpdate(shop.id);
    await deliverDocumentEmails();
    const update = sent.emails.find((m) => m.subject.includes("updated GoKesari banners"));
    expect(update).toBeTruthy();
    expect(pdfs(update!).some((f) => f.includes("seller-sla"))).toBe(false);
  });

  it("TC-WKIT-042 over the size limit: English agreements stay attached, Marathi and Hindi become secure links", async () => {
    const { admin, owner, shop } = await newShop();
    const requestId = await signRegistration(shop.id, owner.id, 300_000);
    // Smaller than the banners alone: no room for the other languages.
    await setRule("sellerAgreements", { maxEmailBytes: 1_000_000 }, { id: admin.id, role: "ADMIN" });
    clearRuleCache();
    await goLive(shop.id, admin);
    await onRegistrationFeePaid(shop.id);
    await deliverDocumentEmails();
    expect(ours()).toHaveLength(1);
    const agreementPdfs = pdfs(ours()[0]).filter((f) => f.includes("seller-sla"));
    expect(agreementPdfs).toEqual(["seller-sla-v1.0-en-signed.pdf"]);
    expect(ours()[0].html).toMatch(/\/api\/agreements\/files\/[0-9a-f-]+\?exp=\d+&amp;sig=/);
    expect(ours()[0].text).toContain("seller-sla-v1.0-mr-signed.pdf: ");
    const [log] = await db.select().from(legalAgreementEmails).where(eq(legalAgreementEmails.signingRequestId, requestId));
    expect(log.attachments!.filter((a) => a.linked).map((a) => a.filename).sort()).toEqual(["seller-sla-v1.0-hi-signed.pdf", "seller-sla-v1.0-mr-signed.pdf"]);
  });
});
