/**
 * Reviewing, e-signing and storing a shop's agreements (docs/seller-agreements-2026-11, brief §2–§4, §6).
 *
 * Flow: the owner opens the personalised documents (built from the shop's own data, in the published
 * languages), ticks each one, enters their full name and designation, requests an SMS code to the registered
 * mobile and enters it. On a correct code — before the code is used up, so a failure leaves it valid — the
 * data is frozen in a snapshot and every language is printed to PDF from that same snapshot with the filled
 * signature blocks; each PDF's SHA-256 is recorded and an Electronic Acceptance Certificate page (listing all
 * the hashes) is appended to the copy the owner downloads. Then, in one transaction: the snapshot, the
 * signing request, one immutable legal_acceptances row per document, the signed files, and the Seller Terms
 * consent. The signed-copy e-mail and SMS notice follow after commit (email.ts).
 *
 * Staff, operators and dealers never sign for the owner: they can only send the owner a signing link
 * (createSigningLink); the owner signs with their own OTP.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";

import { getEnv } from "@/lib/env";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { parseIndianMobile } from "@/lib/contact";
import { maskPhone } from "@/lib/phone";
import { encryptBytes } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import {
  legalAcceptances,
  legalDocumentSnapshots,
  loginOtps,
  legalPlatformAssets,
  legalSignedFiles,
  legalSigningRequests,
  shops,
  users,
  type AppPlatform,
  type LegalDocumentRow,
  type LegalLanguage,
  type SignatureMethod,
  type SigningInitiator,
  type User,
} from "@/server/db/schema";
import { consumeCode, issueCode } from "@/server/otp/service";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { recordConsent } from "@/server/services/consents";
import { getRule } from "@/server/services/settings";
import { SELLER_TERMS_VERSION } from "@/lib/legal/seller-undertaking";

import { canonicalJson, materialFingerprint, sha256Hex, type AgreementSnapshot } from "./data";
import { DESIGNATION_LABELS, dateTimeIst, type Constitution, type Designation } from "./i18n";
import { printHtmlToPdf } from "./pdf/html-to-pdf";
import { currentDocumentsFor, type CurrentDocument, type SignedDocType } from "./registry";
import { renderAgreementHtml, renderCertificateHtml } from "./render";
import { getAgreementStatus, markSatisfied, type AgreementStatus } from "./requirements";
import { buildShopSnapshot, type SnapshotExtras } from "./snapshot";

/* ------------------------------------------------------------ helpers */

export function platformFromUserAgent(userAgent: string | null | undefined): AppPlatform {
  const m = /GoKesariApp\/[\w.]+\s*\((android|ios)\)/i.exec(userAgent ?? "");
  return m ? (m[1].toLowerCase() as AppPlatform) : "web";
}

const site = () => getEnv().AUTH_URL?.replace(/\/$/, "") ?? "https://gokesari.com";

export function verifyUrl(code: string): string {
  return `${site()}/agreements/verify/${code}`;
}

function newVerifyCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  return `GKA-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

async function sealDataUrl(assetId: string | null): Promise<string | null> {
  if (!assetId) return null;
  const [asset] = await db.select().from(legalPlatformAssets).where(eq(legalPlatformAssets.id, assetId)).limit(1);
  return asset ? `data:${asset.contentType};base64,${Buffer.from(asset.data).toString("base64")}` : null;
}

/** The mobile the code goes to: the owner's verified number, else the mobile the shop was registered with. */
export function signingMobile(owner: Pick<User, "phoneE164" | "phoneVerifiedAt">, shopPhone: string | null): string {
  if (owner.phoneE164 && owner.phoneVerifiedAt) return owner.phoneE164;
  const parsed = shopPhone ? parseIndianMobile(shopPhone) : null;
  if (parsed?.ok) return parsed.e164;
  throw validationFailed("There is no registered mobile number to send the signing code to. Add a verified mobile to the shop owner's account first.");
}

/** Pages run in parallel in the shared browser; three at a time keeps memory modest. */
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/* ------------------------------------------------------------ context */

type Owner = User;

export type SigningContext = {
  shopId: string;
  owner: Owner;
  /** Set when the owner signs through a link (no session). */
  linkRequestId?: string | null;
};

export async function loadOwner(shopId: string): Promise<{ owner: Owner; shop: typeof shops.$inferSelect }> {
  const [shop] = await db.select().from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt))).limit(1);
  if (!shop) throw notFound("Shop");
  const [owner] = await db.select().from(users).where(eq(users.id, shop.ownerId)).limit(1);
  if (!owner) throw notFound("Shop owner");
  return { owner, shop };
}

/* ------------------------------------------------------------ preview */

export type PreviewOptions = SnapshotExtras & { lang: LegalLanguage; docType: SignedDocType };

/** The personalised, unsigned document for the viewer (HTML) — exactly what would be signed with these choices. */
export async function previewAgreement(shopId: string, options: PreviewOptions): Promise<{ html: string; missing: string[]; version: string; title: string }> {
  const { shop } = await loadOwner(shopId);
  const doc = (await currentDocumentsFor(shop.shopType)).find((d) => d.docType === options.docType);
  const row = doc?.languages[options.lang];
  if (!doc || !row) throw notFound("Agreement in this language");
  const snapshot = await buildShopSnapshot(shopId, options);
  const rendered = renderAgreementHtml(row, snapshot, { effectiveAt: new Date(), signature: { signed: false }, preview: true });
  return { html: rendered.html, missing: rendered.missing, version: row.version, title: row.title };
}

export async function previewAgreementPdf(shopId: string, options: PreviewOptions): Promise<{ pdf: Buffer; filename: string }> {
  const preview = await previewAgreement(shopId, options);
  if (preview.missing.length) throw validationFailed(`This document can't be prepared yet: ${preview.missing.join(", ")} missing.`);
  const pdf = await printHtmlToPdf(preview.html, { footerNote: `${preview.title} v${preview.version} – preview` });
  return { pdf, filename: `${options.docType.toLowerCase()}-v${preview.version}-${options.lang}-preview.pdf` };
}

/* ------------------------------------------------------------ OTP */

export async function sendSigningCode(ctx: SigningContext, ip: string | null): Promise<{ maskedPhone: string; resendAfterSeconds: number; expiryMinutes: number }> {
  const status = await getAgreementStatus(ctx.shopId);
  assertSignable(status);
  const [shop] = await db.select({ phone: shops.phone }).from(shops).where(eq(shops.id, ctx.shopId)).limit(1);
  const target = signingMobile(ctx.owner, shop?.phone ?? null);
  const sent = await issueCode({ email: ctx.owner.email, purpose: "LEGAL_ESIGN", userId: ctx.owner.id, phoneE164: target, ip, bySms: true });
  return { maskedPhone: maskPhone(target), ...sent };
}

function assertSignable(status: AgreementStatus): void {
  if (!status.enabled) throw conflict("Agreement signing is not switched on for this shop.");
  if (status.noPublishedDocuments) throw conflict("There is no published agreement to sign yet.");
  if (!status.required) throw conflict("Your agreements are already signed. Nothing to do.");
  if (status.blockers.length) throw conflict(`Before signing: ${status.blockers.join(" ")}`, { blockers: status.blockers });
}

/* ------------------------------------------------------------ signing */

export type SignInput = {
  code: string;
  signerName: string;
  designation: Designation;
  constitution: Constitution;
  pharmacist?: { name: string; registrationNumber: string } | null;
  /** The documents ticked, with the version the owner saw — a newer version meanwhile → 409. */
  accepted: { docType: SignedDocType; version: string }[];
  languageViewed: LegalLanguage;
  ip: string | null;
  userAgent: string | null;
  geo?: { lat: number; lng: number; accuracyM?: number } | null;
  /**
   * Owner, 28-Nov-2026: a v2 / v3 registration not live yet with an EXPIRED licence signs on the owner's promise to
   * renew it (AgreementStatus.renewals); the promise is recorded with the signature and the follow-up chases it.
   */
  renewalPromise?: boolean;
};

/** Narrow options of the registration paths (the early acceptance applied at shop creation). */
type SignOptions = {
  /** Only these document types are signed now (the rest stay to sign on the agreement screen). */
  onlyDocTypes?: SignedDocType[];
  /** The time the owner accepted (the early acceptance on the draft), recorded instead of now. */
  acceptedAt?: Date;
  /** Shown on the certificate instead of the OTP reference. */
  certificateRef?: string;
  /** Added to the AGREEMENT_SIGNED audit entry. */
  auditExtra?: Record<string, unknown>;
};

type RenderedDoc = {
  doc: CurrentDocument;
  files: { lang: LegalLanguage; row: LegalDocumentRow; signed: Buffer; signedHash: string; certified: Buffer; certifiedHash: string }[];
  verifyCode: string;
};

async function renderSignedSet(
  docs: CurrentDocument[],
  snapshot: AgreementSnapshot,
  snapshotHash: string,
  input: SignInput,
  acceptedAt: Date,
  meta: { otpRef: string; mobileMasked: string; platform: AppPlatform; registeredBy: string | null },
): Promise<RenderedDoc[]> {
  const seal = await sealDataUrl(snapshot.platform.eSealAssetId);
  const signature = { signed: true as const, signerName: input.signerName, designation: input.designation, signedAt: acceptedAt, sealDataUrl: seal };
  const out: RenderedDoc[] = [];
  for (const doc of docs) {
    const langs = (["en", "mr", "hi"] as const).filter((l) => doc.languages[l]);
    const verifyCode = newVerifyCode();
    const bodies = await inBatches(langs, 3, async (lang) => {
      const row = doc.languages[lang]!;
      const rendered = renderAgreementHtml(row, snapshot, { effectiveAt: acceptedAt, signature, preview: false });
      if (rendered.missing.length || rendered.unknownPartials.length) {
        throw validationFailed(`The ${row.title} (${lang}) could not be completed: ${[...rendered.missing, ...rendered.unknownPartials].join(", ")}.`);
      }
      const signed = await printHtmlToPdf(rendered.html, { footerNote: `${row.title} v${row.version} · ${snapshot.seller.sellerId} · ${verifyCode}` });
      return { lang, row, signed, signedHash: sha256Hex(signed) };
    });
    const hashes = Object.fromEntries(bodies.map((b) => [b.lang, b.signedHash])) as Partial<Record<LegalLanguage, string>>;
    const files = await inBatches(bodies, 3, async (b) => {
      const certHtml = renderCertificateHtml({
        lang: b.lang,
        docTitle: b.row.title,
        version: b.row.version,
        snapshot,
        snapshotSha256: snapshotHash,
        signerName: input.signerName,
        designationLabel: DESIGNATION_LABELS[input.designation][b.lang],
        acceptedAt,
        ip: input.ip,
        platform: meta.platform,
        otpRef: meta.otpRef,
        mobileMasked: meta.mobileMasked,
        signedHashes: hashes,
        verifyUrl: verifyUrl(verifyCode),
        registeredBy: meta.registeredBy,
      });
      const cert = await printHtmlToPdf(certHtml, { footerNote: `${b.row.title} v${b.row.version} · ${verifyCode} · Electronic Acceptance Certificate`, pageNumbers: false });
      const certified = await appendPages(b.signed, cert, { title: `${b.row.title} v${b.row.version} – ${snapshot.seller.legalName}`, at: acceptedAt });
      return { ...b, certified, certifiedHash: sha256Hex(certified) };
    });
    out.push({ doc, files, verifyCode });
  }
  return out;
}

async function appendPages(main: Buffer, extra: Buffer, meta: { title: string; at: Date }): Promise<Buffer> {
  const doc = await PDFDocument.load(main);
  const add = await PDFDocument.load(extra);
  for (const page of await doc.copyPages(add, add.getPageIndices())) doc.addPage(page);
  doc.setTitle(meta.title);
  doc.setAuthor("gokesari.com – ASMY Global Trading & Consultancy India Pvt. Ltd.");
  doc.setProducer("gokesari.com seller agreements");
  doc.setCreationDate(meta.at);
  doc.setModificationDate(meta.at);
  return Buffer.from(await doc.save());
}

async function registeredByOf(shop: typeof shops.$inferSelect, linkRequestId: string | null | undefined): Promise<{ role: SigningInitiator; userId: string | null; label: string | null }> {
  if (linkRequestId) {
    const [req] = await db.select().from(legalSigningRequests).where(eq(legalSigningRequests.id, linkRequestId)).limit(1);
    if (req && req.initiatedAs !== "SELF") return { role: req.initiatedAs, userId: req.initiatedByUserId, label: `${req.initiatedAs.toLowerCase()} (${req.initiatedByUserId?.slice(0, 8) ?? "—"})` };
  }
  if (shop.onboardedByUserId && shop.onboardedByUserId !== shop.ownerId) {
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, shop.onboardedByUserId)).limit(1);
    const role: SigningInitiator = u?.role === "ADMIN" ? "ADMIN" : u?.role && /DEALER|FRANCHISE/.test(u.role) ? "DEALER" : "OPERATOR";
    return { role, userId: shop.onboardedByUserId, label: `${role.toLowerCase()} (${shop.onboardedByUserId.slice(0, 8)})` };
  }
  return { role: "SELF", userId: null, label: null };
}

export type SignResult = { signingRequestId: string; acceptanceIds: string[]; signedAt: string; documents: { docType: SignedDocType; version: string; verifyCode: string; languages: LegalLanguage[] }[] };

/**
 * What the certificate shows in place of the OTP reference for an acceptance at a v2 registration (no code was used:
 * ticks + typed name, signature_method REGISTRATION_ACCEPT).
 */
export const REGISTRATION_ACCEPT_REF = "None — accepted at shop registration with ticks and typed name (no OTP)";

/** E-signs with the SMS code (the existing flow: the shop dashboard's review / re-sign, owner links). */
export async function signAgreements(ctx: SigningContext, input: SignInput): Promise<SignResult> {
  return signWith(ctx, input, "SMS_OTP");
}

/**
 * Onboarding v2 (owner, 27-Nov-2026: "while shop registration to see the terms and condition OTP is not required"):
 * the agreements of a shop whose v2 registration is still at its agreement step are accepted with the ticks and the
 * owner's typed name, without an SMS code (signature_method REGISTRATION_ACCEPT, 0220). Everything else is as the
 * e-sign: the same snapshot, PDFs in every published language with their hashes, the certificate (saying how it was
 * accepted), immutable acceptances and the signed copies e-mailed. Any later review or re-sign — from the shop
 * dashboard, a changed licence, a new version — goes through signAgreements with the OTP.
 */
export async function acceptAgreementsAtRegistration(ctx: SigningContext, input: Omit<SignInput, "code">): Promise<SignResult> {
  const { v2SlaPendingForShop } = await import("@/server/onboarding-v2/shop-view");
  if (!(await v2SlaPendingForShop(ctx.shopId))) {
    throw conflict("Accepting without a code is only for a new shop's registration. Sign with the code sent to your mobile.", { reason: "OTP_REQUIRED" });
  }
  return signWith(ctx, { ...input, code: "" }, "REGISTRATION_ACCEPT");
}

/**
 * 0231 (owner, 28-Nov-2026, v3 order): the seller agreement the owner accepted at step 2 of the registration — the
 * published template text, with the ticks and their typed name, before the shop existed — applied to the shop's
 * personalised agreement when the shop row is created, so the owner does not see a second agreement screen. Only the
 * documents accepted then, in the same version, are signed (method REGISTRATION_ACCEPT, the stored time and IP; the
 * certificate says how it was accepted). Anything else the shop now needs (a newer version, the medical agreement of a
 * medical shop) is left to the registration's agreement screen. Returns null when there was nothing to apply.
 * DEFAULT – confirm with Sanjay: the constitution comes from the PAN (designation to match) — the owner was not asked.
 */
export async function applyEarlyRegistrationAcceptance(
  ctx: SigningContext,
  input: { signerName: string; accepted: { docType: SignedDocType; version: string }[]; acceptedAt: Date; ip: string | null; userAgent: string | null; renewalPromise: boolean; draftId: string },
): Promise<SignResult | null> {
  const { v2SlaPendingForShop } = await import("@/server/onboarding-v2/shop-view");
  if (!(await v2SlaPendingForShop(ctx.shopId))) return null;
  const status = await getAgreementStatus(ctx.shopId);
  if (!status.enabled || status.noPublishedDocuments || !status.required) return null;
  const only = status.documents.filter((d) => !d.signed && input.accepted.some((a) => a.docType === d.docType && a.version === d.version)).map((d) => d.docType);
  if (only.length === 0) return null;
  const snapshot = await buildShopSnapshot(ctx.shopId);
  const constitution = snapshot.seller.constitution ?? "PROPRIETORSHIP";
  const { designationFor } = await import("./i18n");
  return signWith(
    ctx,
    {
      code: "",
      signerName: input.signerName,
      designation: designationFor(constitution),
      constitution,
      pharmacist: null,
      accepted: input.accepted,
      languageViewed: "en",
      ip: input.ip,
      userAgent: input.userAgent,
      renewalPromise: input.renewalPromise,
    },
    "REGISTRATION_ACCEPT",
    {
      onlyDocTypes: only,
      acceptedAt: input.acceptedAt,
      certificateRef: `None — accepted at shop registration on ${dateTimeIst(input.acceptedAt)} with ticks and typed name (no OTP); personalised copy made when the shop was created`,
      auditExtra: { earlyAcceptance: { draftId: input.draftId, acceptedAt: input.acceptedAt.toISOString() } },
    },
  );
}

async function signWith(ctx: SigningContext, input: SignInput, method: SignatureMethod, options: SignOptions = {}): Promise<SignResult> {
  const signerName = input.signerName.trim().replace(/\s+/g, " ");
  if (signerName.length < 3 || signerName.length > 120 || !/\p{L}/u.test(signerName)) throw validationFailed("Type your full name as it should appear on the agreement.");
  const status = await getAgreementStatus(ctx.shopId);
  assertSignable(status);
  // Owner, 28-Nov-2026: an expired licence at a registration is renewed after go-live on the owner's promise.
  if (status.renewals.length > 0 && input.renewalPromise !== true) {
    throw validationFailed(`Tick the box to promise the renewal: ${status.renewals.map((r) => r.message).join(" ")}`, {
      reason: "RENEWAL_PROMISE_REQUIRED",
      renewals: status.renewals,
      fields: { renewalPromise: "Required." },
    });
  }
  const toSign = status.documents.filter((d) => !d.signed && (!options.onlyDocTypes || options.onlyDocTypes.includes(d.docType)));
  for (const d of toSign) {
    const ticked = input.accepted.find((a) => a.docType === d.docType);
    if (!ticked) throw validationFailed(`Tick "${d.title}" to accept it.`);
    if (ticked.version !== d.version) throw conflict(`A newer version (${d.version}) of the ${d.title} has been published. Please read it again.`, { reload: true });
  }
  const { owner, shop } = await loadOwner(ctx.shopId);
  if (owner.id !== ctx.owner.id) throw forbidden("Only the shop owner can sign the shop's agreements.");
  const target = signingMobile(owner, shop.phone);
  const current = (await currentDocumentsFor(shop.shopType)).filter((d) => toSign.some((t) => t.docType === d.docType));
  const platform = platformFromUserAgent(input.userAgent);
  const registeredBy = await registeredByOf(shop, ctx.linkRequestId);

  // The certificate names the OTP reference: read the code row that is about to be checked (the same row
  // consumeCode looks up), so every PDF is printed once, inside beforeConsume.
  const byOtp = method === "SMS_OTP";
  const [pendingOtp] = byOtp
    ? await db
        .select({ id: loginOtps.id })
        .from(loginOtps)
        .where(and(eq(loginOtps.email, owner.email), eq(loginOtps.purpose, "LEGAL_ESIGN"), isNull(loginOtps.consumedAt), isNull(loginOtps.supersededAt)))
        .orderBy(desc(loginOtps.createdAt))
        .limit(1)
    : [];
  const otpRef = byOtp ? (pendingOtp?.id ?? "none") : (options.certificateRef ?? REGISTRATION_ACCEPT_REF);

  type Prepared = { snapshot: AgreementSnapshot; snapshotJson: string; snapshotHash: string; rendered: RenderedDoc[]; acceptedAt: Date };
  let prepared: Prepared | null = null;
  const prepare = async () => {
      const acceptedAt = options.acceptedAt ?? new Date();
      const snapshot = await buildShopSnapshot(ctx.shopId, {
        constitution: input.constitution,
        designation: input.designation,
        signerName,
        pharmacist: input.pharmacist ?? null,
      });
      const snapshotJson = canonicalJson(snapshot);
      const snapshotHash = sha256Hex(snapshotJson);
      const rendered = await renderSignedSet(current, snapshot, snapshotHash, { ...input, signerName }, acceptedAt, {
        otpRef,
        mobileMasked: maskPhone(target),
        platform,
        registeredBy: registeredBy.label,
      });
      prepared = { snapshot, snapshotJson, snapshotHash, rendered, acceptedAt };
  };
  let otp: { id: string } | null = null;
  if (byOtp) {
    otp = await consumeCode({
      email: owner.email,
      purpose: "LEGAL_ESIGN",
      code: input.code,
      ip: input.ip,
      phoneE164: target,
      userId: owner.id,
      // Runs once the code is right and before it is used up: if printing fails, the code stays valid.
      beforeConsume: prepare,
    });
  } else {
    await prepare();
  }
  const p = prepared as Prepared | null;
  if (!p) throw new Error("Signing was not prepared");
  if (otp && otp.id !== otpRef) throw conflict("A new code was requested while you were signing. Please enter the newest code.");
  const finalRendered = p.rendered;

  const reason = status.reason ?? "EXISTING_SHOP";
  const result = await db.transaction(async (tx) => {
    const [snap] = await tx
      .insert(legalDocumentSnapshots)
      .values({
        shopId: ctx.shopId,
        ownerUserId: owner.id,
        data: JSON.parse(p.snapshotJson),
        dataSha256: p.snapshotHash,
        materialFingerprint: materialFingerprint(p.snapshot),
        licenceIds: p.snapshot.licences.map((l) => l.sourceId).filter((id): id is string => Boolean(id && /^[0-9a-f-]{36}$/.test(id))),
        licencesAsOf: new Date(p.snapshot.licencesAsOf),
      })
      .returning({ id: legalDocumentSnapshots.id });

    let requestId = ctx.linkRequestId ?? null;
    if (requestId) {
      const [updated] = await tx
        .update(legalSigningRequests)
        .set({ status: "SIGNED", snapshotId: snap.id, otpId: otp?.id ?? null, signatureMethod: method, signedAt: p.acceptedAt, updatedAt: new Date() })
        .where(and(eq(legalSigningRequests.id, requestId), eq(legalSigningRequests.status, "OPEN")))
        .returning({ id: legalSigningRequests.id });
      if (!updated) throw conflict("This signing link was already used or cancelled.");
    } else {
      const [req] = await tx
        .insert(legalSigningRequests)
        .values({ shopId: ctx.shopId, ownerUserId: owner.id, reason, status: "SIGNED", initiatedByUserId: owner.id, initiatedAs: "SELF", snapshotId: snap.id, otpId: otp?.id ?? null, signatureMethod: method, signedAt: p.acceptedAt })
        .returning({ id: legalSigningRequests.id });
      requestId = req.id;
    }

    const acceptanceIds: string[] = [];
    for (const r of finalRendered) {
      const signedHashes = Object.fromEntries(r.files.map((f) => [f.lang, f.signedHash]));
      const certifiedHashes = Object.fromEntries(r.files.map((f) => [f.lang, f.certifiedHash]));
      const [acc] = await tx
        .insert(legalAcceptances)
        .values({
          signingRequestId: requestId!,
          shopId: ctx.shopId,
          userId: owner.id,
          legalDocumentId: r.doc.english.id,
          docType: r.doc.docType,
          version: r.doc.version,
          languageViewed: r.doc.languages[input.languageViewed] ? input.languageViewed : "en",
          acceptedAt: p.acceptedAt,
          ipAddress: input.ip,
          userAgent: input.userAgent?.slice(0, 500) ?? null,
          appPlatform: platform,
          otpVerificationRef: otp?.id ?? null,
          signatureMethod: method,
          signerName,
          signerDesignation: input.designation,
          dataSnapshotId: snap.id,
          licenceIdsIncluded: p.snapshot.licences.map((l) => l.sourceId).filter((id): id is string => Boolean(id && /^[0-9a-f-]{36}$/.test(id))),
          signedPdfHashes: signedHashes,
          certifiedPdfHashes: certifiedHashes,
          templateSha256: r.doc.english.templateSha256,
          registeredByRole: registeredBy.role,
          registeredByUserId: registeredBy.userId,
          geoLocation: input.geo ?? null,
          verifyCode: r.verifyCode,
        })
        .returning({ id: legalAcceptances.id });
      acceptanceIds.push(acc.id);
      for (const f of r.files) {
        for (const [kind, data, sha] of [
          ["SIGNED", f.signed, f.signedHash],
          ["CERTIFIED", f.certified, f.certifiedHash],
        ] as const) {
          await tx.insert(legalSignedFiles).values({ acceptanceId: acc.id, shopId: ctx.shopId, legalDocumentId: f.row.id, language: f.lang, kind, sha256: sha, sizeBytes: data.length, dataEncrypted: encryptBytes(data) });
        }
      }
    }
    // The Agreements step replaces the registration's Seller Terms tick: record that consent too.
    await recordConsent(owner.id, "SELLER_TERMS", { version: SELLER_TERMS_VERSION, shopId: ctx.shopId, ipAddress: input.ip, userAgent: input.userAgent, client: tx });
    await recordAudit(
      {
        actorId: owner.id,
        actorRole: owner.role,
        action: AUDIT_ACTIONS.AGREEMENT_SIGNED,
        entityType: "shop",
        entityId: ctx.shopId,
        newValue: {
          signingRequestId: requestId,
          documents: finalRendered.map((r) => ({ docType: r.doc.docType, version: r.doc.version, verifyCode: r.verifyCode })),
          otpId: otp?.id ?? null,
          signatureMethod: method,
          platform,
          reason,
          snapshotSha256: p.snapshotHash,
          ...(status.renewals.length > 0 ? { renewalsPromised: status.renewals.map((r) => ({ key: r.key, expiredOn: r.expiredOn })) } : {}),
          ...(options.auditExtra ?? {}),
        },
        ipAddress: input.ip,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
      },
      tx,
    );
    return { requestId: requestId!, acceptanceIds };
  });

  // Owner, 28-Nov-2026: the renewal promise given with the signature reaches the documents follow-up.
  if (status.renewals.length > 0) {
    await (await import("@/server/onboarding-v2/licence-renewals"))
      .recordRenewalPromises(ctx.shopId, status.renewals, { userId: owner.id, role: owner.role, ip: input.ip })
      .catch((error: unknown) => console.error("[seller-agreements] renewal promise not recorded", ctx.shopId, error));
  }
  // Only part of what the shop needs was signed (the early acceptance): the rest is still to sign.
  const stillRequired = options.onlyDocTypes ? (await getAgreementStatus(ctx.shopId, { track: false })).required : false;
  if (!stillRequired) await markSatisfied(ctx.shopId, result.requestId);
  // The Seller Terms, Terms of Use and Privacy Policy ticked with the agreements: their current versions.
  await (await import("@/server/services/policy-versions"))
    .recordCurrentAcceptances(owner.id, ["terms", "privacy-policy", "seller-terms"], "SHOP_PORTAL", { ipAddress: input.ip })
    .catch((error: unknown) => console.error("[seller-agreements] policy acceptances failed", error));
  const { afterSigning } = await import("./email");
  await afterSigning({ shopId: ctx.shopId, signingRequestId: result.requestId, reason }).catch((error) => console.error("[seller-agreements] after-signing notice failed", error));

  return {
    signingRequestId: result.requestId,
    acceptanceIds: result.acceptanceIds,
    signedAt: p.acceptedAt.toISOString(),
    documents: finalRendered.map((r) => ({ docType: r.doc.docType, version: r.doc.version, verifyCode: r.verifyCode, languages: r.files.map((f) => f.lang) })),
  };
}

/* ------------------------------------------------------------ owner links */

/**
 * Staff, operators and dealers who registered a shop send its owner a link to review and sign with their own
 * OTP. The shop stays "Pending owner acceptance" (no orders) until the owner signs.
 */
export async function createSigningLink(shopId: string, actor: { id: string; role: string }, initiatedAs: Exclude<SigningInitiator, "SELF">): Promise<{ requestId: string; expiresAt: string; url: string }> {
  const { owner, shop } = await loadOwner(shopId);
  if (owner.id === actor.id) throw validationFailed("You are the owner: open My Agreements and sign yourself.");
  const status = await getAgreementStatus(shopId);
  if (!status.enabled) throw conflict("Agreement signing is not switched on for this shop.");
  if (!status.required) throw conflict("This shop's agreements are already signed.");
  const rule = await getRule("sellerAgreements");
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + rule.linkExpiryDays * 86_400_000);
  const requestId = await db.transaction(async (tx) => {
    await tx
      .update(legalSigningRequests)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(eq(legalSigningRequests.shopId, shopId), eq(legalSigningRequests.status, "OPEN")));
    const [req] = await tx
      .insert(legalSigningRequests)
      .values({ shopId, ownerUserId: owner.id, reason: status.reason ?? "REGISTRATION", status: "OPEN", initiatedByUserId: actor.id, initiatedAs, linkTokenHash: hashToken(token), linkExpiresAt: expiresAt, linkSentAt: new Date() })
      .returning({ id: legalSigningRequests.id });
    await recordAudit({ actorId: actor.id, actorRole: actor.role as never, action: AUDIT_ACTIONS.AGREEMENT_LINK_SENT, entityType: "shop", entityId: shopId, newValue: { requestId: req.id, initiatedAs, expiresAt: expiresAt.toISOString() } }, tx);
    return req.id;
  });
  const url = `${site()}/agreements/sign/${token}`;
  const { sendSigningLinkNotice } = await import("./email");
  await sendSigningLinkNotice({ shopId, shopName: shop.name, ownerId: owner.id, url, expiresAt, requestId });
  return { requestId, expiresAt: expiresAt.toISOString(), url };
}

/** Resolves an owner link to its open request (no session needed: the OTP to the registered mobile proves the owner). */
export async function resolveSigningLink(token: string): Promise<{ requestId: string; shopId: string; owner: Owner }> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound("Signing link");
  const [req] = await db
    .select()
    .from(legalSigningRequests)
    .where(and(eq(legalSigningRequests.linkTokenHash, hashToken(token)), eq(legalSigningRequests.status, "OPEN"), gt(legalSigningRequests.linkExpiresAt, new Date())))
    .orderBy(desc(legalSigningRequests.createdAt))
    .limit(1);
  if (!req) throw notFound("This signing link has expired or was already used. Ask for a new one, or sign in and open My Agreements");
  const { owner } = await loadOwner(req.shopId);
  if (owner.id !== req.ownerUserId) throw conflict("The shop's owner changed since this link was sent. Ask for a new link.");
  return { requestId: req.id, shopId: req.shopId, owner };
}

/** The open link request for a shop, if any (admin view: "Pending owner acceptance"). */
export async function openLinkRequest(shopId: string) {
  const [req] = await db
    .select({ id: legalSigningRequests.id, initiatedAs: legalSigningRequests.initiatedAs, linkSentAt: legalSigningRequests.linkSentAt, linkExpiresAt: legalSigningRequests.linkExpiresAt })
    .from(legalSigningRequests)
    .where(and(eq(legalSigningRequests.shopId, shopId), eq(legalSigningRequests.status, "OPEN")))
    .orderBy(desc(legalSigningRequests.createdAt))
    .limit(1);
  return req ?? null;
}

export { dateTimeIst };
