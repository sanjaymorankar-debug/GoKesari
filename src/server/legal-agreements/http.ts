/**
 * Shared pieces of the agreement API routes (docs/seller-agreements-2026-11): the sign request schema, the
 * owner-facing view, and safe HTML / PDF responses.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { AGREEMENT_LANGUAGES } from "@/server/db/schema";

import { shopAgreementHistory } from "./admin";
import { CONSTITUTIONS, DESIGNATIONS, designationFor } from "./i18n";
import { SIGNED_DOC_TYPES } from "./registry";
import { getAgreementStatus } from "./requirements";
import { loadOwner, openLinkRequest, signingMobile } from "./signing";
import { buildShopSnapshot } from "./snapshot";
import { maskPhone } from "@/lib/phone";

import { ASSET_ORIGIN } from "./pdf/html-to-pdf";

export function clientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
}

export const previewQuery = z.object({
  doc: z.enum(SIGNED_DOC_TYPES),
  lang: z.enum(AGREEMENT_LANGUAGES).default("en"),
  format: z.enum(["html", "pdf"]).default("html"),
  constitution: z.enum(CONSTITUTIONS).optional(),
  designation: z.enum(DESIGNATIONS).optional(),
  name: z.string().trim().max(120).optional(),
  pharmacistName: z.string().trim().max(120).optional(),
  pharmacistReg: z.string().trim().max(60).optional(),
});
export type PreviewQuery = z.infer<typeof previewQuery>;

export function previewExtras(q: PreviewQuery) {
  return {
    docType: q.doc,
    lang: q.lang,
    constitution: q.constitution ?? null,
    designation: q.designation ?? null,
    signerName: q.name || null,
    pharmacist: q.pharmacistName && q.pharmacistReg ? { name: q.pharmacistName, registrationNumber: q.pharmacistReg } : null,
  };
}

export const signBody = z.object({
  action: z.literal("sign"),
  code: z.string().trim().min(4).max(8),
  signerName: z.string().trim().min(3).max(120),
  designation: z.enum(DESIGNATIONS),
  constitution: z.enum(CONSTITUTIONS),
  pharmacist: z.object({ name: z.string().trim().min(3).max(120), registrationNumber: z.string().trim().min(2).max(60) }).nullable().optional(),
  accepted: z.array(z.object({ docType: z.enum(SIGNED_DOC_TYPES), version: z.string().max(10), scrolledToEnd: z.literal(true, { message: "Read each document to the end before ticking it." }) })).min(1),
  languageViewed: z.enum(AGREEMENT_LANGUAGES).default("en"),
  /** The platform-wide documents every seller accepts with the agreements: Seller Terms, Terms of Use, Privacy Policy. */
  acceptPolicies: z.literal(true, { message: "Tick the box to accept the Seller Terms, Terms of Use and Privacy Policy." }),
  geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).optional() }).nullable().optional(),
});

/**
 * Onboarding v2 registration (owner, 27-Nov-2026): the same form without the SMS code — accepted with the ticks and
 * the typed name, only while the shop's v2 registration is at its agreement step (acceptAgreementsAtRegistration).
 */
export const registrationAcceptBody = signBody.omit({ action: true, code: true }).extend({ action: z.literal("accept") });

/** Everything the Agreements screen needs for one shop. */
export async function ownerAgreementsView(shopId: string) {
  const [status, history, link] = await Promise.all([getAgreementStatus(shopId), shopAgreementHistory(shopId), openLinkRequest(shopId)]);
  const { owner, shop } = await loadOwner(shopId);
  let maskedMobile: string | null = null;
  try {
    maskedMobile = maskPhone(signingMobile(owner, shop.phone));
  } catch {
    maskedMobile = null;
  }
  const snapshot = status.required ? await buildShopSnapshot(shopId) : null;
  const medical = status.documents.some((d) => d.docType === "MEDICAL_ONBOARDING");
  return {
    ...status,
    shopName: shop.name,
    sellerId: shop.registrationNumber,
    history,
    pendingOwnerLink: link ? { sentAt: link.linkSentAt?.toISOString() ?? null, expiresAt: link.linkExpiresAt?.toISOString() ?? null, by: link.initiatedAs } : null,
    maskedMobile,
    defaults: snapshot
      ? {
          signerName: snapshot.owner.name,
          constitution: snapshot.seller.constitution,
          designation: designationFor(snapshot.seller.constitution),
          pharmacistNeeded: medical && !snapshot.pharmacist,
        }
      : null,
  };
}

/**
 * Agreement HTML for the in-site viewer. The page fetches it and shows it in a sandboxed srcdoc frame (no
 * scripts); the fonts and watermark come from /api/agreements/assets (the PDF printer serves them itself).
 */
export function agreementHtmlResponse(html: string): NextResponse {
  return new NextResponse(html.split(ASSET_ORIGIN).join("/api/agreements/assets"), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src data: https://legal-assets.gokesari.invalid; style-src 'unsafe-inline'; font-src 'none'",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}

export function pdfResponse(pdf: Buffer, filename: string, inline = false): NextResponse {
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/[^\w.-]+/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/* ------------------------------------------------------------ admin template input */

const sourceValues = z
  .object({
    commissionPct: z.number().min(0).max(50).optional(),
    settlementDays: z.number().int().min(0).max(60).optional(),
    registrationFeeRupees: z.number().min(0).max(1_000_000).optional(),
    wholesaleRegistrationFeeRupees: z.number().min(0).max(1_000_000).optional(),
    acceptMinutes: z.number().int().min(0).max(1440).optional(),
    slaChargesRupees: z.record(z.enum(["lateReady", "sellerCancel", "lateThenCancel", "defect", "medicineBreach"]), z.number().min(0).max(100_000)).optional(),
  })
  .strict();

export const templateInput = z.object({
  docType: z.enum(SIGNED_DOC_TYPES),
  language: z.enum(AGREEMENT_LANGUAGES),
  version: z.string().trim().max(10),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().trim().max(200).optional(),
  templateBody: z.string().min(50).max(400_000),
  appliesToShopTypes: z.array(z.string().trim().max(60)).max(50).optional(),
  sourceValues: sourceValues.optional(),
  changeSummary: z.string().trim().max(2000).nullable().optional(),
  requiresResign: z.boolean().optional(),
});

