/**
 * Flow spec v3, F4 shop onboarding (docs/flows-v3/wave3.md, flag flow_f4, rule shopFlowsV3). Owner, 27-Nov-2026:
 *
 * - The registration asks for the shop's WhatsApp number and its payment QR, both optional. In onboarding v2 they
 *   are offered on the agreement step (the shop row exists from there): the number goes to shops.whatsapp_number
 *   (the field of the shop's settings, shown to customers with a wa.me link), the QR through the welcome-kit
 *   upload (shop-banner/upi-qr.ts saveBannerUpiQr: read, checked as a UPI payment QR, kept as its text).
 * - The seller agreement accepted at registration (no OTP) is e-mailed on acceptance in English, Marathi and Hindi:
 *   the signed PDFs when the agreements engine made them (legal-agreements/email.ts queueSignedCopy, sent now
 *   when the shop is not live yet — a live shop's welcome kit already carries them), otherwise one e-mail in the
 *   three languages with links to the terms and the undertaking accepted.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { parseIndianMobile } from "@/lib/contact";
import { getEnv } from "@/lib/env";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { SELLER_TERMS_VERSION, SELLER_UNDERTAKING_VERSION } from "@/lib/legal/seller-undertaking";
import { db } from "@/server/db";
import { legalAgreementEmails, legalSigningRequests, shopRegistrationDrafts, shops } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

import { wave3Switch } from "./wave3-rules";

/* ------------------------------------------------------------ contact */

export interface RegistrationContactView {
  whatsappNumber: string | null;
  /** The payee of the uploaded payment QR (its UPI ID), or null. */
  qrVpa: string | null;
  qrPayeeName: string | null;
}

/** The v2 agreement step's optional contact card: null when not asked (flag or switch off, or no shop yet). */
export async function registrationContactView(shopId: string | null): Promise<RegistrationContactView | null> {
  if (!shopId || !(await wave3Switch("askContactAtRegistration"))) return null;
  const [shop] = await db.select({ whatsapp: shops.whatsappNumber }).from(shops).where(eq(shops.id, shopId));
  if (!shop) return null;
  const { bannerUpiQrInfo } = await import("@/server/shop-banner/upi-qr");
  const qr = await bannerUpiQrInfo(shopId).catch(() => null);
  return { whatsappNumber: shop.whatsapp, qrVpa: qr?.vpa ?? null, qrPayeeName: qr?.payeeName ?? null };
}

/** Pure: a WhatsApp number as the shop settings keep it (10 digits), or an error. Empty clears. */
export function parseWhatsappNumber(raw: string | null | undefined): { ok: true; value: string | null } | { ok: false; error: string } {
  const text = raw?.trim() ?? "";
  if (text === "") return { ok: true, value: null };
  const parsed = parseIndianMobile(text);
  const national = parsed.ok ? parsed.e164.slice(-10) : "";
  if (!parsed.ok || !/^[6-9]\d{9}$/.test(national)) return { ok: false, error: "Enter a valid 10-digit Indian mobile number for WhatsApp." };
  return { ok: true, value: national };
}

/**
 * Saves the optional WhatsApp number and / or payment QR given on the v2 agreement step. Only the draft's owner, only
 * once the shop row exists. `whatsappNumber: undefined` leaves it, "" clears it.
 */
export async function saveRegistrationContact(
  actor: { id: string; staff?: { id: string } | null },
  input: { whatsappNumber?: string | null; qrImage?: Buffer | null },
): Promise<RegistrationContactView> {
  if (!(await wave3Switch("askContactAtRegistration"))) throw notFound("Page");
  const [draft] = await db
    .select({ shopId: shopRegistrationDrafts.shopId })
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.ownerId, actor.id), eq(shopRegistrationDrafts.flowVersion, "v2"), inArray(shopRegistrationDrafts.status, ["SUBMITTED", "COMPLETED"])))
    .orderBy(desc(shopRegistrationDrafts.updatedAt))
    .limit(1);
  if (!draft?.shopId) throw conflict("Continue to your seller agreement first.", { reason: "STEP_OPEN" });
  const shopId = draft.shopId;
  if (input.whatsappNumber !== undefined) {
    const parsed = parseWhatsappNumber(input.whatsappNumber);
    if (!parsed.ok) throw validationFailed(parsed.error, { fields: { whatsappNumber: parsed.error } });
    const [before] = await db.select({ whatsapp: shops.whatsappNumber }).from(shops).where(eq(shops.id, shopId));
    if ((before?.whatsapp ?? null) !== parsed.value) {
      await db.update(shops).set({ whatsappNumber: parsed.value, updatedAt: new Date() }).where(eq(shops.id, shopId));
      await recordAudit({
        actorId: actor.staff?.id ?? actor.id,
        action: AUDIT_ACTIONS.SHOP_UPDATED,
        entityType: "shop",
        entityId: shopId,
        previousValue: { whatsappNumber: before?.whatsapp ?? null },
        newValue: { whatsappNumber: parsed.value, via: "registration (flow_f4)" },
      });
    }
  }
  if (input.qrImage && input.qrImage.length > 0) {
    const { saveBannerUpiQr } = await import("@/server/shop-banner/upi-qr");
    await saveBannerUpiQr(shopId, input.qrImage, actor.staff?.id ?? actor.id);
  }
  return (await registrationContactView(shopId))!;
}

/* ------------------------------------------------- agreement e-mail */

export const SELLER_TERMS_ACCEPTED_DOC = "SELLER_TERMS_ACCEPTED" as const;

/** Pure: the three-language e-mail confirming the Seller Terms + undertaking accepted at registration (links only). */
export function sellerTermsAcceptedEmail(input: { shopName: string; acceptedAtIst: string; baseUrl: string }): { title: string; body: string } {
  const terms = `${input.baseUrl}/legal/seller-terms`;
  const title = `${input.shopName}: your seller agreement with gokesari.com`;
  const body = [
    `English — ${input.shopName} accepted the gokesari.com Marketplace Seller Terms (version ${SELLER_TERMS_VERSION}) and the seller undertaking (version ${SELLER_UNDERTAKING_VERSION}) on ${input.acceptedAtIst}. Read them any time: ${terms}`,
    "",
    `मराठी — ${input.shopName} ने ${input.acceptedAtIst} रोजी gokesari.com विक्रेता अटी (आवृत्ती ${SELLER_TERMS_VERSION}) आणि विक्रेता हमीपत्र (आवृत्ती ${SELLER_UNDERTAKING_VERSION}) स्वीकारले. कधीही वाचा: ${terms}`,
    "",
    `हिंदी — ${input.shopName} ने ${input.acceptedAtIst} को gokesari.com विक्रेता शर्तें (संस्करण ${SELLER_TERMS_VERSION}) और विक्रेता वचनपत्र (संस्करण ${SELLER_UNDERTAKING_VERSION}) स्वीकार किए। कभी भी पढ़ें: ${terms}`,
    "",
    "In case of any difference between language versions, the English version shall prevail.",
  ].join("\n");
  return { title, body };
}

/**
 * Right after the owner accepted at the v2 registration (acceptV2Agreement, after commit and go-live). Never throws:
 * the e-mails have their own retries. Returns what was queued ("SIGNED_COPY", "LINKS") or null.
 */
export async function emailAgreementOnAcceptance(shopId: string, acceptedAt: Date): Promise<"SIGNED_COPY" | "LINKS" | null> {
  try {
    if (!(await wave3Switch("agreementEmailOnAcceptance"))) return null;
    const [shop] = await db.select({ id: shops.id, name: shops.name, ownerId: shops.ownerId, status: shops.status }).from(shops).where(eq(shops.id, shopId));
    if (!shop) return null;
    const [signed] = await db
      .select({ id: legalSigningRequests.id })
      .from(legalSigningRequests)
      .where(and(eq(legalSigningRequests.shopId, shopId), eq(legalSigningRequests.status, "SIGNED"), eq(legalSigningRequests.reason, "REGISTRATION")))
      .orderBy(desc(legalSigningRequests.signedAt))
      .limit(1);
    if (signed) {
      // Live already: the welcome kit carries the signed PDFs (legal-agreements/email.ts, one mail for a new shop).
      if (shop.status === "APPROVED") return null;
      const [copy] = await db.select({ id: legalAgreementEmails.id }).from(legalAgreementEmails).where(and(eq(legalAgreementEmails.signingRequestId, signed.id), eq(legalAgreementEmails.kind, "SIGNED_COPY"))).limit(1);
      if (copy) return null;
      const { queueSignedCopy } = await import("@/server/legal-agreements/email");
      await queueSignedCopy(signed.id, { kind: "SIGNED_COPY", includeBanners: false });
      return "SIGNED_COPY";
    }
    const { formatIstStamp } = await import("@/server/onboarding-v2/roles");
    const mail = sellerTermsAcceptedEmail({ shopName: shop.name, acceptedAtIst: formatIstStamp(acceptedAt), baseUrl: getEnv().AUTH_URL ?? "" });
    const { queueDocumentEmail } = await import("@/server/documents/email");
    const queued = await queueDocumentEmail({
      docType: SELLER_TERMS_ACCEPTED_DOC,
      docId: shopId,
      userId: shop.ownerId,
      recipientRole: "SHOP_OWNER",
      title: mail.title,
      body: mail.body,
      actionUrl: "/legal/seller-terms",
      category: "SHOP",
      mandatory: true,
    });
    return queued ? "LINKS" : null;
  } catch (error) {
    console.error("[flows-v3 f4] agreement e-mail on acceptance not queued", shopId, error);
    return null;
  }
}

