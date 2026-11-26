/**
 * Admin and operator views of signed agreements (docs/seller-agreements-2026-11, brief §6): the acceptance
 * record with filters, CSV export, the signed PDFs, the pending / overdue counts, the company e-seal, and the
 * public verification of a signed copy by its code and hash.
 */
import { createHash } from "node:crypto";

import { and, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import sharp from "sharp";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { decryptBytes } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import {
  legalAcceptances,
  legalPlatformAssets,
  legalShopAgreementStates,
  legalSignedFiles,
  legalSigningRequests,
  shops,
  type LegalLanguage,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule, setRule } from "@/server/services/settings";

import { dateTimeIst } from "./i18n";
import { DOC_TITLES, type SignedDocType } from "./registry";

export type AcceptanceFilter = { shop?: string; docType?: string; version?: string; from?: string; to?: string; limit?: number; offset?: number };

function filterWhere(f: AcceptanceFilter): SQL | undefined {
  const parts: (SQL | undefined)[] = [];
  if (f.shop?.trim()) {
    const q = f.shop.trim();
    parts.push(/^[0-9a-f-]{36}$/i.test(q) ? eq(legalAcceptances.shopId, q) : or(ilike(shops.name, `%${q}%`), ilike(shops.registrationNumber, `%${q}%`), ilike(legalAcceptances.verifyCode, `%${q}%`)));
  }
  if (f.docType) parts.push(eq(legalAcceptances.docType, f.docType as SignedDocType));
  if (f.version) parts.push(eq(legalAcceptances.version, f.version));
  // Dates are IST calendar days.
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) parts.push(gte(legalAcceptances.acceptedAt, new Date(`${f.from}T00:00:00+05:30`)));
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) parts.push(lte(legalAcceptances.acceptedAt, new Date(`${f.to}T23:59:59.999+05:30`)));
  const present = parts.filter(Boolean) as SQL[];
  return present.length ? and(...present) : undefined;
}

export async function listAcceptances(f: AcceptanceFilter) {
  const where = filterWhere(f);
  const rows = await db
    .select({ a: legalAcceptances, shopName: shops.name, sellerId: shops.registrationNumber })
    .from(legalAcceptances)
    .leftJoin(shops, eq(shops.id, legalAcceptances.shopId))
    .where(where)
    .orderBy(desc(legalAcceptances.acceptedAt))
    .limit(Math.min(f.limit ?? 50, 500))
    .offset(f.offset ?? 0);
  const [{ n }] = await db.select({ n: count() }).from(legalAcceptances).leftJoin(shops, eq(shops.id, legalAcceptances.shopId)).where(where);
  const files = rows.length
    ? await db
        .select({ id: legalSignedFiles.id, acceptanceId: legalSignedFiles.acceptanceId, language: legalSignedFiles.language, kind: legalSignedFiles.kind, sha256: legalSignedFiles.sha256, sizeBytes: legalSignedFiles.sizeBytes })
        .from(legalSignedFiles)
        .where(inArray(legalSignedFiles.acceptanceId, rows.map((r) => r.a.id)))
    : [];
  return {
    total: n,
    rows: rows.map(({ a, shopName, sellerId }) => ({
      id: a.id,
      signingRequestId: a.signingRequestId,
      shopId: a.shopId,
      shopName,
      sellerId,
      docType: a.docType,
      docTitle: DOC_TITLES[a.docType as SignedDocType]?.en ?? a.docType,
      version: a.version,
      languageViewed: a.languageViewed,
      acceptedAt: a.acceptedAt.toISOString(),
      acceptedAtIst: dateTimeIst(a.acceptedAt),
      signerName: a.signerName,
      signerDesignation: a.signerDesignation,
      appPlatform: a.appPlatform,
      ipAddress: a.ipAddress,
      otpVerificationRef: a.otpVerificationRef,
      registeredByRole: a.registeredByRole,
      registeredByUserId: a.registeredByUserId,
      verifyCode: a.verifyCode,
      signedPdfHashes: a.signedPdfHashes,
      licenceCount: a.licenceIdsIncluded.length,
      files: files.filter((f) => f.acceptanceId === a.id),
    })),
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Formula injection guard for spreadsheets.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function acceptancesCsv(f: AcceptanceFilter): Promise<string> {
  const { rows } = await listAcceptances({ ...f, limit: 500, offset: 0 });
  const head = [
    "accepted_at_ist", "shop", "seller_id", "shop_id", "document", "version", "language_viewed", "signer_name", "designation",
    "platform", "ip_address", "otp_ref", "registered_by", "verify_code", "sha256_en", "sha256_mr", "sha256_hi", "licences_included",
  ];
  const lines = rows.map((r) =>
    [
      r.acceptedAtIst, r.shopName, r.sellerId, r.shopId, r.docTitle, r.version, r.languageViewed, r.signerName, r.signerDesignation,
      r.appPlatform, r.ipAddress, r.otpVerificationRef, r.registeredByRole, r.verifyCode,
      r.signedPdfHashes.en, r.signedPdfHashes.mr, r.signedPdfHashes.hi, r.licenceCount,
    ].map(csvCell).join(","),
  );
  return `${head.join(",")}\n${lines.join("\n")}\n`;
}

/** Shops that must sign: total, overdue (grace passed: no new orders), waiting for the owner's link. */
export async function pendingCounts(now: Date = new Date()) {
  const [open] = await db
    .select({
      pending: count(),
      overdue: sql<number>`count(*) FILTER (WHERE ${legalShopAgreementStates.graceUntil} <= ${now.toISOString()}::timestamptz AND ${legalShopAgreementStates.reason} <> 'REGISTRATION')::int`,
    })
    .from(legalShopAgreementStates)
    .where(isNull(legalShopAgreementStates.satisfiedAt));
  const [links] = await db.select({ n: count() }).from(legalSigningRequests).where(eq(legalSigningRequests.status, "OPEN"));
  const list = await db
    .select({ shopId: legalShopAgreementStates.shopId, name: shops.name, reason: legalShopAgreementStates.reason, requiredSince: legalShopAgreementStates.requiredSince, graceUntil: legalShopAgreementStates.graceUntil })
    .from(legalShopAgreementStates)
    .innerJoin(shops, eq(shops.id, legalShopAgreementStates.shopId))
    .where(isNull(legalShopAgreementStates.satisfiedAt))
    .orderBy(legalShopAgreementStates.graceUntil)
    .limit(200);
  return {
    pending: open?.pending ?? 0,
    overdue: open?.overdue ?? 0,
    awaitingOwnerLink: links?.n ?? 0,
    shops: list.map((r) => ({ ...r, requiredSince: r.requiredSince.toISOString(), graceUntil: r.graceUntil.toISOString(), graceUntilIst: dateTimeIst(r.graceUntil), overdue: r.reason !== "REGISTRATION" && r.graceUntil <= now })),
  };
}

/* ------------------------------------------------------------ files */

export async function readSignedFile(fileId: string, access: { shopIds?: string[]; staff?: boolean }): Promise<{ data: Buffer; filename: string; sha256: string }> {
  const [f] = await db.select().from(legalSignedFiles).where(eq(legalSignedFiles.id, fileId)).limit(1);
  if (!f) throw notFound("Signed document");
  if (!access.staff && !access.shopIds?.includes(f.shopId)) throw forbidden("This document belongs to another shop.");
  const [a] = await db.select({ docType: legalAcceptances.docType, version: legalAcceptances.version, code: legalAcceptances.verifyCode }).from(legalAcceptances).where(eq(legalAcceptances.id, f.acceptanceId)).limit(1);
  const data = decryptBytes(Buffer.from(f.dataEncrypted));
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== f.sha256) throw new Error(`Signed file ${fileId} does not match its recorded hash`);
  const base = `${(a?.docType ?? "agreement").toLowerCase().replace(/_/g, "-")}-v${a?.version ?? ""}-${f.language}${f.kind === "SIGNED" ? "-without-certificate" : ""}-${a?.code ?? ""}`;
  return { data, filename: `${base}.pdf`, sha256: f.sha256 };
}

/** My Agreements: the shop's signed documents, newest first. */
export async function shopAgreementHistory(shopId: string) {
  const acceptances = await db.select().from(legalAcceptances).where(eq(legalAcceptances.shopId, shopId)).orderBy(desc(legalAcceptances.acceptedAt));
  const files = acceptances.length
    ? await db
        .select({ id: legalSignedFiles.id, acceptanceId: legalSignedFiles.acceptanceId, language: legalSignedFiles.language, kind: legalSignedFiles.kind, sha256: legalSignedFiles.sha256, sizeBytes: legalSignedFiles.sizeBytes })
        .from(legalSignedFiles)
        .where(and(inArray(legalSignedFiles.acceptanceId, acceptances.map((a) => a.id)), eq(legalSignedFiles.kind, "CERTIFIED")))
    : [];
  return acceptances.map((a) => ({
    id: a.id,
    docType: a.docType,
    title: DOC_TITLES[a.docType as SignedDocType]?.en ?? a.docType,
    version: a.version,
    signedAt: a.acceptedAt.toISOString(),
    signedAtIst: dateTimeIst(a.acceptedAt),
    signerName: a.signerName,
    verifyCode: a.verifyCode,
    files: files.filter((f) => f.acceptanceId === a.id).map((f) => ({ id: f.id, language: f.language as LegalLanguage, sha256: f.sha256, sizeBytes: f.sizeBytes })),
  }));
}

/* ------------------------------------------------------------ verification */

/** Public: what was signed under a verification code (no personal data beyond the shop name). */
export async function verifyCodeSummary(code: string) {
  if (!/^GKA-[A-Z2-9]{10}$/.test(code)) throw notFound("Verification code");
  const [row] = await db
    .select({ a: legalAcceptances, shopName: shops.name })
    .from(legalAcceptances)
    .leftJoin(shops, eq(shops.id, legalAcceptances.shopId))
    .where(eq(legalAcceptances.verifyCode, code))
    .limit(1);
  if (!row) throw notFound("Verification code");
  const files = await db.select({ language: legalSignedFiles.language, kind: legalSignedFiles.kind, sha256: legalSignedFiles.sha256 }).from(legalSignedFiles).where(eq(legalSignedFiles.acceptanceId, row.a.id));
  return {
    code,
    document: DOC_TITLES[row.a.docType as SignedDocType]?.en ?? row.a.docType,
    version: row.a.version,
    shopName: row.shopName,
    signedAtIst: dateTimeIst(row.a.acceptedAt),
    signerName: row.a.signerName,
    hashes: files.map((f) => ({ language: f.language, kind: f.kind, sha256: f.sha256 })),
  };
}

/** True when `sha256` is one of the files recorded under the code. */
export async function verifyHash(code: string, sha256: string): Promise<{ match: boolean; language?: string; kind?: string }> {
  const summary = await verifyCodeSummary(code);
  const hit = summary.hashes.find((h) => h.sha256 === sha256.toLowerCase());
  return hit ? { match: true, language: hit.language, kind: hit.kind } : { match: false };
}

/* ------------------------------------------------------------ settings: e-seal */

export async function uploadESeal(data: Buffer, contentType: string, actor: { id: string; role: string }): Promise<{ assetId: string }> {
  if (!["image/png", "image/jpeg"].includes(contentType)) throw validationFailed("Upload the e-seal as a PNG or JPEG image.");
  if (data.length === 0 || data.length > 1_000_000) throw validationFailed("The e-seal image must be under 1 MB.");
  // Re-encode: strips metadata and anything that is not an image.
  const clean = await sharp(data).rotate().resize({ width: 600, height: 600, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const [asset] = await db
    .insert(legalPlatformAssets)
    .values({ kind: "E_SEAL", contentType: "image/png", sha256: createHash("sha256").update(clean).digest("hex"), sizeBytes: clean.length, data: clean, uploadedBy: actor.id })
    .returning({ id: legalPlatformAssets.id });
  const rule = await getRule("sellerAgreements");
  await setRule("sellerAgreements", { ...rule, eSealAssetId: asset.id }, actor as never);
  await recordAudit({ actorId: actor.id, actorRole: actor.role as never, action: AUDIT_ACTIONS.AGREEMENT_SETTINGS_CHANGED, entityType: "legal_platform_asset", entityId: asset.id, newValue: { eSeal: true } });
  return { assetId: asset.id };
}

export async function readESeal(assetId: string): Promise<{ data: Buffer; contentType: string } | null> {
  const [asset] = await db.select().from(legalPlatformAssets).where(eq(legalPlatformAssets.id, assetId)).limit(1);
  return asset ? { data: Buffer.from(asset.data), contentType: asset.contentType } : null;
}

export { shops };
