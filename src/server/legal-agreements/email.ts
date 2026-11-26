/**
 * The signed-copy e-mail, the SMS / WhatsApp notice and the owner signing link (docs/seller-agreements-2026-11,
 * brief §7). Event-driven: queued the moment the agreements are signed (existing shops) or the moment the
 * registration fee is paid after signing (new shops); the document_emails outbox sends it at once and retries
 * after 5 min, 30 min and 2 h, then alerts admins. Every send is logged (status, Message-ID, time) on its
 * document_emails row; legal_agreement_emails records what was attached or linked.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";

import { getEnv } from "@/lib/env";
import { notFound } from "@/lib/errors";
import { decryptBytes } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import {
  documentEmails,
  legalAcceptances,
  legalAgreementEmails,
  legalSignedFiles,
  legalSigningRequests,
  shops,
  users,
  type LegalLanguage,
  type SigningReason,
} from "@/server/db/schema";
import { queueDocumentEmail, type RenderedDocument } from "@/server/documents/email";
import type { EmailAttachment } from "@/server/email/transport";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";

import { dateTimeIst, LANGUAGE_NAMES } from "./i18n";
import { DOC_TITLES, type SignedDocType } from "./registry";
import { MY_AGREEMENTS_URL } from "./requirements";
import { escapeHtml as e } from "./template-engine";

const site = () => getEnv().AUTH_URL?.replace(/\/$/, "") ?? "https://gokesari.com";

export function agreementEmailSubject(shopName: string): string {
  return `${shopName} – your signed gokesari.com agreements | आपले स्वाक्षरी केलेले करार | आपके हस्ताक्षरित अनुबंध`;
}

/* ------------------------------------------------------------ download links */

const LINK_DAYS = 30;

function linkSecret(): string {
  return `seller-agreements:${getEnv().AUTH_SECRET}`;
}

/** A signed, expiring link to one signed file (used when attachments would exceed the e-mail limit). */
export function signedFileLink(fileId: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + LINK_DAYS * 86_400;
  const sig = createHmac("sha256", linkSecret()).update(`${fileId}.${exp}`).digest("base64url");
  return `${site()}/api/agreements/files/${fileId}?exp=${exp}&sig=${sig}`;
}

export function checkFileLink(fileId: string, exp: string | null, sig: string | null, now = Date.now()): boolean {
  if (!exp || !sig || !/^\d{9,11}$/.test(exp) || Number(exp) * 1000 < now) return false;
  const expected = createHmac("sha256", linkSecret()).update(`${fileId}.${exp}`).digest();
  const given = Buffer.from(sig, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/* ------------------------------------------------------------ queueing */

async function hasPaidRegistration(shopId: string): Promise<boolean> {
  const [shop] = await db.select({ fee: shops.feePaymentStatus, registration: shops.registrationStatus }).from(shops).where(eq(shops.id, shopId)).limit(1);
  return shop?.fee === "PAID" || (shop?.registration !== undefined && shop.registration !== null && shop.registration !== "UNPAID");
}

/** Queues one signed-copy e-mail for a signing request. Returns the send-log row id. */
export async function queueSignedCopy(signingRequestId: string, options: { kind: "SIGNED_COPY" | "RESEND"; includeBanners: boolean; requestedBy?: string | null }): Promise<string> {
  const [req] = await db.select().from(legalSigningRequests).where(eq(legalSigningRequests.id, signingRequestId)).limit(1);
  if (!req || req.status !== "SIGNED") throw notFound("Signed agreements");
  const [shop] = await db.select({ name: shops.name }).from(shops).where(eq(shops.id, req.shopId)).limit(1);
  const [log] = await db
    .insert(legalAgreementEmails)
    .values({ signingRequestId, shopId: req.shopId, kind: options.kind, includeBanners: options.includeBanners, requestedBy: options.requestedBy ?? null })
    .returning({ id: legalAgreementEmails.id });
  await queueDocumentEmail({
    docType: "SELLER_AGREEMENTS",
    docId: log.id,
    userId: req.ownerUserId,
    recipientRole: "SHOP_OWNER",
    title: agreementEmailSubject(shop?.name ?? "Your shop"),
    body: "Your signed gokesari.com agreements are attached.",
    actionUrl: MY_AGREEMENTS_URL,
    category: "SHOP",
    maxAttempts: 4,
    mandatory: true,
  });
  return log.id;
}

/** Right after signing: the SMS / WhatsApp notice now; the e-mail now, or (new shop) once the fee is paid. */
export async function afterSigning(input: { shopId: string; signingRequestId: string; reason: SigningReason }): Promise<void> {
  const [shop] = await db.select({ name: shops.name, ownerId: shops.ownerId }).from(shops).where(eq(shops.id, input.shopId)).limit(1);
  if (!shop) return;
  const url = `${site()}${MY_AGREEMENTS_URL}?shop=${input.shopId}`;
  await notify({
    userId: shop.ownerId,
    type: NOTIFICATION_TYPES.SHOP_AGREEMENT_SIGNED,
    vars: {
      title: `${shop.name}: agreements signed`,
      message: [
        `${shop.name}: your gokesari.com agreements are signed. View or download them in My Agreements: ${url}`,
        `${shop.name}: आपले gokesari.com करार स्वाक्षरीत झाले. माझे करार येथे पहा: ${url}`,
        `${shop.name}: आपके gokesari.com अनुबंध हस्ताक्षरित हो गए। मेरे अनुबंध में देखें: ${url}`,
      ].join("\n"),
    },
    actionUrl: `${MY_AGREEMENTS_URL}?shop=${input.shopId}`,
    channels: ["SMS", "WHATSAPP", "PUSH"],
    mandatory: true,
    dedupeKey: `agreement-signed:${input.signingRequestId}`,
    metadata: { shopId: input.shopId, signingRequestId: input.signingRequestId },
  });
  const isNew = input.reason === "REGISTRATION";
  if (isNew && !(await hasPaidRegistration(input.shopId))) return; // sent by onRegistrationFeePaid
  await queueSignedCopy(input.signingRequestId, { kind: "SIGNED_COPY", includeBanners: isNew });
}

/** Registration fee captured: send the new shop its signed agreements (with the welcome banners) once. */
export async function onRegistrationFeePaid(shopId: string): Promise<void> {
  const [req] = await db
    .select({ id: legalSigningRequests.id })
    .from(legalSigningRequests)
    .where(and(eq(legalSigningRequests.shopId, shopId), eq(legalSigningRequests.status, "SIGNED"), eq(legalSigningRequests.reason, "REGISTRATION")))
    .orderBy(desc(legalSigningRequests.signedAt))
    .limit(1);
  if (!req) return;
  const [already] = await db.select({ id: legalAgreementEmails.id }).from(legalAgreementEmails).where(and(eq(legalAgreementEmails.signingRequestId, req.id), eq(legalAgreementEmails.kind, "SIGNED_COPY"))).limit(1);
  if (already) return;
  await queueSignedCopy(req.id, { kind: "SIGNED_COPY", includeBanners: true });
}

/** Admin / operator "Resend signed copy". */
export async function resendSignedCopy(signingRequestId: string, actor: { id: string; role: string }, includeBanners = false): Promise<string> {
  const id = await queueSignedCopy(signingRequestId, { kind: "RESEND", includeBanners, requestedBy: actor.id });
  await recordAudit({ actorId: actor.id, actorRole: actor.role as never, action: AUDIT_ACTIONS.AGREEMENT_COPY_RESENT, entityType: "legal_signing_request", entityId: signingRequestId, newValue: { emailId: id, includeBanners } });
  return id;
}

/* ------------------------------------------------------------ rendering at send time */

async function compressPdf(data: Buffer): Promise<Buffer> {
  try {
    const doc = await PDFDocument.load(data);
    const smaller = Buffer.from(await doc.save({ useObjectStreams: true }));
    return smaller.length < data.length ? smaller : data;
  } catch {
    return data;
  }
}

/** Base64 grows a file by 4/3; the limit is on the e-mail as sent. */
const encodedSize = (bytes: number) => Math.ceil(bytes / 3) * 4;

export async function renderAgreementEmail(emailId: string): Promise<RenderedDocument | null> {
  const [log] = await db.select().from(legalAgreementEmails).where(eq(legalAgreementEmails.id, emailId)).limit(1);
  if (!log) return null;
  const [req] = await db.select().from(legalSigningRequests).where(eq(legalSigningRequests.id, log.signingRequestId)).limit(1);
  const [shop] = await db.select().from(shops).where(eq(shops.id, log.shopId)).limit(1);
  if (!req || !shop) return null;
  const acceptances = await db.select().from(legalAcceptances).where(eq(legalAcceptances.signingRequestId, req.id)).orderBy(asc(legalAcceptances.docType));
  if (acceptances.length === 0) return null;
  const files = await db
    .select()
    .from(legalSignedFiles)
    .where(and(inArray(legalSignedFiles.acceptanceId, acceptances.map((a) => a.id)), eq(legalSignedFiles.kind, "CERTIFIED")));
  const rule = await getRule("sellerAgreements");
  const isNew = req.reason === "REGISTRATION";
  const signedAt = acceptances[0].acceptedAt;

  type Item = { filename: string; content: Buffer; english: boolean; banner: boolean; fileId: string | null };
  const items: Item[] = [];
  const order: LegalLanguage[] = ["en", "mr", "hi"];
  for (const acc of acceptances) {
    for (const lang of order) {
      const f = files.find((x) => x.acceptanceId === acc.id && x.language === lang);
      if (!f) continue;
      const content = await compressPdf(decryptBytes(Buffer.from(f.dataEncrypted)));
      items.push({ filename: `${acc.docType.toLowerCase().replace(/_/g, "-")}-v${acc.version}-${lang}-signed.pdf`, content, english: lang === "en", banner: false, fileId: f.id });
    }
  }
  if (log.includeBanners && shop.status === "APPROVED") {
    try {
      const { renderShopBanner, shopPageUrl, bannerBasename } = await import("@/server/shop-banner/render");
      for (const lang of ["en", "mr", "hi"] as const) {
        const banner = await renderShopBanner({ shopName: shop.name, url: shopPageUrl(shop.slug), lang });
        items.push({ filename: `${bannerBasename(shop.slug, lang)}.pdf`, content: banner.pdf, english: true, banner: true, fileId: null });
      }
    } catch (error) {
      console.error("[seller-agreements] banner render failed", error);
    }
  }

  // Within the limit: everything. Over it: English agreements + banners attached, the rest as secure links.
  const total = items.reduce((n, i) => n + encodedSize(i.content.length), 0);
  const attach = total <= rule.maxEmailBytes ? items : items.filter((i) => i.english || i.banner);
  const linked = items.filter((i) => !attach.includes(i));
  const attachments: EmailAttachment[] = attach.map((i) => ({ filename: i.filename, content: i.content, contentType: "application/pdf" }));

  await db
    .update(legalAgreementEmails)
    .set({ attachments: items.map((i) => ({ filename: i.filename, bytes: i.content.length, linked: linked.includes(i) })) })
    .where(eq(legalAgreementEmails.id, emailId));

  const docs = acceptances.map((a) => ({ title: DOC_TITLES[a.docType as SignedDocType]?.en ?? a.docType, version: a.version, langs: files.filter((f) => f.acceptanceId === a.id).map((f) => LANGUAGE_NAMES[f.language]) }));
  const [snapRow] = await db.select({ ids: legalAcceptances.licenceIdsIncluded }).from(legalAcceptances).where(eq(legalAcceptances.id, acceptances[0].id)).limit(1);
  void snapRow;
  const { legalDocumentSnapshots } = await import("@/server/db/schema");
  const [snap] = acceptances[0].dataSnapshotId
    ? await db.select({ data: legalDocumentSnapshots.data }).from(legalDocumentSnapshots).where(eq(legalDocumentSnapshots.id, acceptances[0].dataSnapshotId)).limit(1)
    : [];
  const licences = ((snap?.data as { licences?: { kind: string; number: string }[] } | undefined)?.licences ?? []).map((l) => `${l.kind.replace(/_/g, " ").toLowerCase()} ${l.number}`);
  const when = dateTimeIst(signedAt);
  const dashboard = `${site()}${MY_AGREEMENTS_URL}?shop=${shop.id}`;
  const linkLines = linked.map((i) => `${i.filename}: ${signedFileLink(i.fileId!)}`);

  const text = [
    isNew ? `Congratulations! ${shop.name} is registered on gokesari.com.` : `This confirms the agreements ${shop.name} signed on gokesari.com.`,
    `Attached is the agreement you reviewed, digitally signed and accepted on ${when}.`,
    `Documents signed: ${docs.map((d) => `${d.title} v${d.version} (${d.langs.join(", ")})`).join("; ")}.`,
    licences.length ? `Licences included in Annexure A: ${licences.join("; ")}.` : "",
    linkLines.length ? `Download (links valid ${LINK_DAYS} days):\n${linkLines.join("\n")}` : "",
    `Your dashboard: ${dashboard}`,
    `Support: ${rule.supportPhone}`,
    "",
    isNew ? `अभिनंदन! ${shop.name} ची gokesari.com वर नोंदणी झाली आहे.` : `${shop.name} ने gokesari.com वर स्वाक्षरी केलेल्या करारांची ही पुष्टी आहे.`,
    `आपण पाहिलेला करार, ${when} रोजी डिजिटल स्वाक्षरी करून स्वीकारलेला, सोबत जोडला आहे. डॅशबोर्ड: ${dashboard} · मदत: ${rule.supportPhone}`,
    "",
    isNew ? `बधाई हो! ${shop.name} gokesari.com पर पंजीकृत हो गई है।` : `यह ${shop.name} द्वारा gokesari.com पर हस्ताक्षरित अनुबंधों की पुष्टि है।`,
    `आपके द्वारा देखा गया अनुबंध, ${when} को डिजिटल हस्ताक्षर कर स्वीकार किया गया, संलग्न है। डैशबोर्ड: ${dashboard} · सहायता: ${rule.supportPhone}`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const list = (items: string[]) => `<ul style="margin:4px 0 10px;padding-left:18px">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
  const html = `
<div style="font-family:Arial,'Noto Sans Devanagari',sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">
  <h2 style="color:#1f3a68;margin:0 0 8px">${e(isNew ? `Congratulations, ${shop.name}!` : `${shop.name}: signed agreements`)}</h2>
  <p>${e(isNew ? "Your shop is registered on gokesari.com." : "This confirms the agreements you signed on gokesari.com.")} Attached is the agreement you reviewed, digitally signed and accepted on <strong>${e(when)}</strong>.</p>
  <p style="margin-bottom:2px"><strong>Documents signed</strong></p>
  ${list(docs.map((d) => `${e(d.title)} – version ${e(d.version)} (${e(d.langs.join(", "))})`))}
  ${licences.length ? `<p style="margin-bottom:2px"><strong>Licences included (Annexure A)</strong></p>${list(licences.map(e))}` : ""}
  ${linked.length ? `<p style="margin-bottom:2px"><strong>Download</strong> (secure links, valid ${LINK_DAYS} days)</p>${list(linked.map((i) => `<a href="${e(signedFileLink(i.fileId!))}">${e(i.filename)}</a>`))}` : ""}
  <p><a href="${e(dashboard)}" style="background:#1f3a68;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Open My Agreements</a></p>
  <p>Support: ${e(rule.supportPhone)}</p>
  <hr style="border:none;border-top:1px solid #ddd;margin:16px 0"/>
  <p lang="mr">${e(isNew ? `अभिनंदन! ${shop.name} ची gokesari.com वर नोंदणी झाली आहे.` : `${shop.name} ने gokesari.com वर स्वाक्षरी केलेल्या करारांची ही पुष्टी आहे.`)} आपण पाहिलेला करार, <strong>${e(when)}</strong> रोजी डिजिटल स्वाक्षरी करून स्वीकारलेला, सोबत जोडला आहे. मदतीसाठी: ${e(rule.supportPhone)}</p>
  <p lang="hi">${e(isNew ? `बधाई हो! ${shop.name} gokesari.com पर पंजीकृत हो गई है।` : `यह ${shop.name} द्वारा gokesari.com पर हस्ताक्षरित अनुबंधों की पुष्टि है।`)} आपके द्वारा देखा गया अनुबंध, <strong>${e(when)}</strong> को डिजिटल हस्ताक्षर कर स्वीकार किया गया, संलग्न है। सहायता: ${e(rule.supportPhone)}</p>
  <p style="font-size:12px;color:#666">In case of any difference between language versions, the English version shall prevail.</p>
</div>`;

  return { attachments, html, text, cc: rule.ccEmails };
}

/* ------------------------------------------------------------ failures and links */

/** Retries used up: tell the admins. */
export async function alertAgreementEmailFailed(emailId: string, attempts: number, error: string): Promise<void> {
  const [log] = await db.select().from(legalAgreementEmails).where(eq(legalAgreementEmails.id, emailId)).limit(1);
  const [shop] = log ? await db.select({ name: shops.name }).from(shops).where(eq(shops.id, log.shopId)).limit(1) : [];
  const admins = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "ADMIN"), isNull(users.deletedAt)));
  for (const admin of admins) {
    await notify({
      userId: admin.id,
      type: NOTIFICATION_TYPES.STAFF_AGREEMENT_EMAIL_FAILED,
      vars: { shopName: shop?.name ?? "a shop", attempts, error: error.slice(0, 200) },
      actionUrl: "/admin/agreements?tab=acceptances",
      channels: ["EMAIL"],
      dedupeKey: `agreement-email-dead:${emailId}:${admin.id}`,
    });
  }
}

/** The signing link to the owner, by SMS, WhatsApp and e-mail (staff / dealer registered the shop). */
export async function sendSigningLinkNotice(input: { shopId: string; shopName: string; ownerId: string; url: string; expiresAt: Date; requestId: string }): Promise<void> {
  const till = dateTimeIst(input.expiresAt);
  await notify({
    userId: input.ownerId,
    type: NOTIFICATION_TYPES.SHOP_AGREEMENT_SIGN_REQUEST,
    vars: {
      title: `${input.shopName}: review and sign your gokesari.com agreements`,
      message: [
        `${input.shopName} was registered on gokesari.com for you. Review your personalised agreements and sign them with the code sent to your mobile: ${input.url} (link valid until ${till}). The shop gets no orders until you sign.`,
        `${input.shopName}: आपले वैयक्तिक करार वाचा आणि मोबाईलवर आलेल्या कोडने स्वाक्षरी करा: ${input.url} (${till} पर्यंत वैध).`,
        `${input.shopName}: अपने व्यक्तिगत अनुबंध पढ़ें और मोबाइल पर आए कोड से हस्ताक्षर करें: ${input.url} (${till} तक मान्य).`,
      ].join("\n"),
    },
    actionUrl: `${MY_AGREEMENTS_URL}?shop=${input.shopId}`,
    channels: ["SMS", "WHATSAPP", "EMAIL", "PUSH"],
    mandatory: true,
    dedupeKey: `agreement-link:${input.requestId}`,
    metadata: { shopId: input.shopId, requestId: input.requestId },
  });
}

/** The send log of one signing request's e-mails (admin view). */
export async function emailLogFor(signingRequestId: string) {
  const logs = await db.select().from(legalAgreementEmails).where(eq(legalAgreementEmails.signingRequestId, signingRequestId)).orderBy(desc(legalAgreementEmails.createdAt));
  if (logs.length === 0) return [];
  const sends = await db
    .select()
    .from(documentEmails)
    .where(and(eq(documentEmails.docType, "SELLER_AGREEMENTS"), inArray(documentEmails.docId, logs.map((l) => l.id))));
  return logs.map((l) => {
    const s = sends.find((x) => x.docId === l.id);
    return {
      id: l.id,
      kind: l.kind,
      createdAt: l.createdAt.toISOString(),
      status: s?.status ?? "NOT_QUEUED",
      attempts: s?.attempts ?? 0,
      sentAt: s?.sentAt?.toISOString() ?? null,
      messageId: s?.messageId ?? null,
      to: s?.toAddress ?? null,
      cc: s?.ccAddresses ?? null,
      lastError: s?.lastError ?? null,
      attachments: l.attachments ?? [],
    };
  });
}
