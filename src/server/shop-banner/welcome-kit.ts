/**
 * docs/shop-welcome-kit-2026-11 — the automatic welcome e-mail with the shop's
 * printable banner (owner request, 20-Nov-2026; personalised 26-Nov-2026).
 *
 * The moment a shop goes live (approveShopTransaction: admin / operator
 * approval, automatic approval, instant GST/PAN approval; approveRegistration:
 * paid self-registration) the welcome kit is queued in the same transaction,
 * in the document-email outbox (documents/email.ts): one row per shop, ever
 * (whoever owns it), so a shop that is suspended and approved again, or that
 * changes hands, is not welcomed twice. The outbox sends it just after commit and retries a failed send with
 * backoff (cron every-minute is the safety net); no SMTP or no real e-mail
 * address → SKIPPED, never an error. A second safety net (runWelcomeKitSafetyNet,
 * 26-Nov-2026) queues the kit for any shop that went live after that release
 * without one.
 *
 * The banner is drawn at send time (render.ts) from the shop as it is then —
 * shop name, owner name, shop QR and the "Pay here (UPI)" QR — so nothing large
 * is stored. The e-mail congratulates the owner by name, shows the banners,
 * attaches them as print-ready A4 PDFs, and tells the owner to print them and
 * put them up at the shop. Queuing never blocks an approval: it runs in a
 * savepoint and a failure is only logged.
 */
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { conflict, notFound } from "@/lib/errors";
import { LEGAL_ENTITY } from "@/lib/legal-docs";
import { db, type DbClient } from "@/server/db";
import { documentEmails, invSettings, shops } from "@/server/db/schema";
import { queueDocumentEmail, type RenderedDocument } from "@/server/documents/email";
import { renderEmail } from "@/server/notifications/templates";
import { getRule } from "@/server/services/settings";

import {
  BANNER_LANGUAGE_LABEL,
  bannerBasename,
  bannerOwnerName,
  localBannerLanguage,
  parseUpiQr,
  renderShopBanner,
  shopPageUrl,
  upiBannerPayload,
  type BannerLanguage,
} from "./render";

export const WELCOME_KIT_DOC_TYPE = "SHOP_WELCOME_KIT";
/** 26-Nov-2026: an admin's "Resend updated banner" for one shop (its own outbox type: not counted as the welcome kit). */
export const BANNER_UPDATE_DOC_TYPE = "SHOP_BANNER_UPDATE";
/** The inline banners' Content-IDs in the HTML body. */
export const welcomeBannerCid = (lang: BannerLanguage) => `gk-shop-banner-${lang}`;

/** 26-Nov-2026 owner brief: the contact line and the footer of the welcome e-mail. */
export const SUPPORT_EMAIL = LEGAL_ENTITY.supportEmail;
export const SUPPORT_PHONE = "+91 91751 93009";
export const WELCOME_FOOTER = `gokesari.com is a unit of ${LEGAL_ENTITY.legalName}`;

function siteBase(): string {
  return (getEnv().AUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
}

export function welcomeKitTitle(shopName: string): string {
  return `Congratulations! ${shopName} is now live on GoKesari.com`;
}

export const PRINT_STEPS = [
  "Print in COLOUR on a colour page — not black and white. The GoKesari saffron colours are part of the banner.",
  "Print the attached PDFs on A4 paper (landscape, \"Fit to page\"): one banner in English, one in your local language. A print shop can also make them as a sticker or flex board from the same files.",
  "Before you put it up, scan the QR code with your phone: it must open your shop's page on GoKesari.",
  "Put it at your counter or shop entrance at eye level, where every customer can see and scan it. Laminate it to keep it safe from rain and dust.",
  "Tell your customers: \"Scan this to order from our shop on GoKesari.\"",
] as const;

/** One line in the local language, so the owner sees the key instruction in their own language too. */
export const LOCAL_PRINT_LINE: Record<Exclude<BannerLanguage, "en">, string> = {
  mr: "तुमचे GoKesari बॅनर (इंग्रजी आणि मराठी) रंगीत प्रिंट करा आणि दुकानात ग्राहकांना दिसेल अशा ठिकाणी लावा.",
  hi: "अपने GoKesari बैनर (अंग्रेज़ी और हिंदी) रंगीन प्रिंट करें और दुकान में ग्राहकों को दिखे ऐसी जगह लगाएँ।",
};

/** What the welcome e-mail says about one shop. */
export interface WelcomeKitContent {
  shopName: string;
  /** Printable owner name (bannerOwnerName), or null: the e-mail then opens "Dear Shop Owner". */
  ownerName: string | null;
  shopUrl: string;
  local: Exclude<BannerLanguage, "en">;
  /** The UPI id on the banner's "Pay here (UPI)" QR, "uploaded" for the owner's own payment QR, or null (no UPI panel). */
  upi: string | null;
  /** "update": an admin's "Resend updated banner" (no congratulations a second time). */
  kind?: "welcome" | "update";
}

export function welcomeKitGreeting(ownerName: string | null): string {
  return `Dear ${ownerName ?? "Shop Owner"},`;
}

export function welcomeKitOpening(c: Pick<WelcomeKitContent, "ownerName" | "shopName" | "kind">): string {
  if (c.kind === "update") return `${welcomeKitGreeting(c.ownerName)} here are the updated GoKesari banners for ${c.shopName}.`;
  return `${welcomeKitGreeting(c.ownerName)} congratulations! ${c.shopName} is now live on GoKesari.com`;
}

export function upiLine(c: Pick<WelcomeKitContent, "upi">): string {
  if (c.upi === "uploaded") return `The banner also has a "Pay here (UPI)" QR from the payment QR you uploaded: customers can pay you from any UPI app.`;
  if (c.upi) return `The banner also has a "Pay here (UPI)" QR for your UPI ID ${c.upi}: customers can pay you from any UPI app.`;
  return `Add your UPI ID to get a "Pay here (UPI)" QR on the banner too: Seller Central → Accounts → Settings → UPI ID (${siteBase()}/shop/accounts/settings). Then download the banner again from Seller Central → Marketing.`;
}

export const contactLine = () => `Questions? Write to ${SUPPORT_EMAIL} or call ${SUPPORT_PHONE}.`;

/** The plain-text part (queued in the outbox; renderEmail adds the title, link and footer). */
export function welcomeKitText(c: WelcomeKitContent): string {
  return [
    c.kind === "update" ? welcomeKitOpening(c) : `${welcomeKitOpening(c)} — customers near you can now find your shop and order from it.`,
    `Your two shop banners are attached — English and ${BANNER_LANGUAGE_LABEL[c.local]} — as print-ready PDFs. Each shows your shop's name${c.ownerName ? ", your name" : ""} and an "Order online" QR code of your own shop page. Customers who scan it come straight to your shop — no need to search on GoKesari or on Google: ${c.shopUrl}`,
    upiLine(c),
    `Print them in colour and put them up at your shop:\n${PRINT_STEPS.map((step, i) => `${i + 1}. ${step}`).join("\n")}`,
    LOCAL_PRINT_LINE[c.local],
    `Next: add your products so customers can order — ${siteBase()}/shop/manage/products`,
    `You can download both banners again at any time from Seller Central → Marketing: ${siteBase()}/shop/marketing. Help: ${siteBase()}/support`,
    contactLine(),
    WELCOME_FOOTER,
  ].join("\n\n");
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Where renderShopWelcomeKit puts the signed-agreements section (empty for shops without one). */
const AGREEMENTS_SLOT = "<!--signed-agreements-->";

export function welcomeKitHtml(c: WelcomeKitContent): string {
  const name = escapeHtml(c.shopName);
  const base = siteBase();
  const p = (html: string) => `<p style="color:#44403c;line-height:1.5;margin:0 0 12px">${html}</p>`;
  const link = (href: string, label: string, colour = "#c2410c") => `<a href="${escapeHtml(href)}" style="color:${colour}">${escapeHtml(label)}</a>`;
  const upi =
    c.upi === "uploaded" || c.upi
      ? escapeHtml(upiLine(c))
      : `Add your UPI ID to get a <strong>"Pay here (UPI)"</strong> QR on the banner too: Seller Central → Accounts → Settings → UPI ID (${link(`${base}/shop/accounts/settings`, "open Settings")}). Then download the banner again from Seller Central → Marketing.`;
  return (
    `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:600px">` +
    `<h2 style="margin:0 0 8px;color:#1c1917">${escapeHtml(c.kind === "update" ? `Your updated GoKesari banners for ${c.shopName}` : welcomeKitTitle(c.shopName))}</h2>` +
    p(
      c.kind === "update"
        ? escapeHtml(welcomeKitOpening(c))
        : `${escapeHtml(welcomeKitGreeting(c.ownerName))} congratulations! <strong>${name}</strong> is now live on GoKesari.com — customers near you can now find your shop and order from it.`,
    ) +
    p(
      `Here are your two shop banners — <strong>English</strong> and <strong>${escapeHtml(BANNER_LANGUAGE_LABEL[c.local])}</strong>. Each shows your shop's name${c.ownerName ? ", your name" : ""} and an <strong>"Order online"</strong> QR code of your own shop page. Customers who scan it come straight to your shop — no need to search on GoKesari or on Google.`,
    ) +
    (["en", c.local] as const)
      .map(
        (lang) =>
          `<p style="margin:0 0 12px"><img src="cid:${welcomeBannerCid(lang)}" alt="Your GoKesari shop banner for ${name} (${escapeHtml(BANNER_LANGUAGE_LABEL[lang])})" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0"></p>`,
      )
      .join("") +
    p(upi) +
    `<h3 style="margin:16px 0 8px;color:#c2410c">Print them in colour and put them up at your shop</h3>` +
    `<ol style="color:#44403c;line-height:1.5;margin:0 0 12px;padding-left:20px">${PRINT_STEPS.map((step) => `<li style="margin:0 0 6px">${escapeHtml(step)}</li>`).join("")}</ol>` +
    p(`<strong>${escapeHtml(LOCAL_PRINT_LINE[c.local])}</strong>`) +
    AGREEMENTS_SLOT +
    p(`Your shop page: ${link(c.shopUrl, c.shopUrl)}`) +
    `<p style="margin:16px 0"><a href="${base}/shop/manage/products" style="background:#c2410c;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;display:inline-block">Add your products</a></p>` +
    p(`Questions? Write to ${link(`mailto:${SUPPORT_EMAIL}`, SUPPORT_EMAIL)} or call ${link(`tel:${SUPPORT_PHONE.replace(/\s+/g, "")}`, SUPPORT_PHONE)}.`) +
    `<p style="color:#78716c;font-size:12px;line-height:1.5;margin:0 0 8px">You can download both banners again at any time from ${link(`${base}/shop/marketing`, "Seller Central → Marketing", "#78716c")}. Help: ${link(`${base}/support`, `${base}/support`, "#78716c")}</p>` +
    `<p style="color:#78716c;font-size:12px;line-height:1.5;margin:0">${escapeHtml(WELCOME_FOOTER)}</p>` +
    `</div>`
  );
}

/* ------------------------------------------------------------ the shop's banner inputs */

interface BannerShop {
  id: string;
  name: string;
  slug: string;
  status: string;
  deletedAt: Date | null;
  state: string | null;
  pincode: string | null;
  ownerId: string;
  ownerName: string | null;
  upiVpa: string | null;
  bannerUpiQr: string | null;
}

async function loadBannerShop(shopId: string, client: DbClient = db): Promise<BannerShop | null> {
  const [shop] = await client
    .select({
      id: shops.id,
      name: shops.name,
      slug: shops.slug,
      status: shops.status,
      deletedAt: shops.deletedAt,
      state: shops.state,
      pincode: shops.pincode,
      ownerId: shops.ownerId,
      ownerName: shops.ownerName,
      upiVpa: invSettings.upiVpa,
      bannerUpiQr: invSettings.bannerUpiQr,
    })
    .from(shops)
    .leftJoin(invSettings, eq(invSettings.shopId, shops.id))
    .where(eq(shops.id, shopId));
  return shop ?? null;
}

/**
 * Name source (26-Nov-2026): `shops.owner_name` — the owner's name as entered for this shop at registration (the
 * wizard fills it from the PAN holder's name, staff type it when registering on the owner's behalf). Not the
 * account's display name, which may be blank, a nickname or an e-mail address, and is shared by every shop the
 * mobile number owns. Cleaned by bannerOwnerName(): no line when there is nothing printable.
 */
function contentFor(shop: BannerShop, kind: WelcomeKitContent["kind"] = "welcome"): WelcomeKitContent {
  const uploaded = shop.bannerUpiQr ? parseUpiQr(shop.bannerUpiQr) : null;
  const payload = upiBannerPayload({ uploadedQr: shop.bannerUpiQr, vpa: shop.upiVpa, shopName: shop.name });
  return {
    shopName: shop.name,
    ownerName: bannerOwnerName(shop.ownerName),
    shopUrl: shopPageUrl(shop.slug),
    local: localBannerLanguage(shop),
    upi: !payload ? null : uploaded ? "uploaded" : (shop.upiVpa?.trim() ?? null),
    kind,
  };
}

/* ------------------------------------------------------------ queueing */

/**
 * Queues the welcome kit for a shop that just went live. Call it inside the
 * approval transaction (pass `tx`): the row commits with the approval. Returns
 * whether a row was queued (false: already welcomed, opted out, or failed).
 */
export async function queueShopWelcomeKit(
  shop: { id: string; ownerId: string; name: string; slug: string; state?: string | null; pincode?: string | null; ownerName?: string | null },
  client: DbClient = db,
  options: { deliverNow?: boolean } = {},
): Promise<boolean> {
  try {
    // A savepoint: if queuing fails, only it is rolled back — never the approval around it.
    return await client.transaction(async (sp) => {
      // Once per shop, ever: the outbox's own key is shop + recipient, so a shop that changed hands
      // would be welcomed again without this check.
      const [already] = await sp
        .select({ id: documentEmails.id })
        .from(documentEmails)
        .where(and(eq(documentEmails.docType, WELCOME_KIT_DOC_TYPE), eq(documentEmails.docId, shop.id)))
        .limit(1);
      if (already) return false;
      const loaded = await loadBannerShop(shop.id, sp);
      const content = loaded
        ? contentFor(loaded)
        : { shopName: shop.name, ownerName: bannerOwnerName(shop.ownerName), shopUrl: shopPageUrl(shop.slug), local: localBannerLanguage(shop), upi: null };
      return queueDocumentEmail(
        {
          docType: WELCOME_KIT_DOC_TYPE,
          docId: shop.id,
          userId: shop.ownerId,
          recipientRole: "SHOP_OWNER",
          title: welcomeKitTitle(shop.name),
          body: welcomeKitText(content),
          actionUrl: "/shop/marketing",
          category: "SHOP",
          deliverNow: options.deliverNow,
        },
        sp,
      );
    });
  } catch (error) {
    console.error("[welcome-kit] could not queue", shop.id, error instanceof Error ? error.message : error);
    return false;
  }
}

/** Least time between two "Resend updated banner" e-mails to one shop. */
export const BANNER_RESEND_COOLDOWN_MINUTES = 10;

/**
 * 26-Nov-2026: an admin's "Resend updated banner" for one live shop — the current banners (owner line, UPI QR)
 * without a second congratulations. Its own outbox row per shop (SHOP_BANNER_UPDATE): a resend re-arms that row,
 * so the outbox keeps the latest resend and the audit log keeps each one. Never counted as the welcome kit, so it
 * does not stop the automatic kit and is never sent automatically.
 */
export async function queueBannerUpdate(shopId: string): Promise<{ toUserId: string }> {
  const shop = await loadBannerShop(shopId);
  if (!shop || shop.deletedAt) throw notFound("Shop");
  if (shop.status !== "APPROVED") throw conflict("Only a live shop has a banner to send.");
  const content = contentFor(shop, "update");
  const email = renderEmail({ title: `Your updated GoKesari banners for ${shop.name}`, body: welcomeKitText(content), actionUrl: "/shop/marketing", baseUrl: getEnv().AUTH_URL });
  const [existing] = await db
    .select({ id: documentEmails.id, status: documentEmails.status, updatedAt: documentEmails.updatedAt, userId: documentEmails.userId })
    .from(documentEmails)
    .where(and(eq(documentEmails.docType, BANNER_UPDATE_DOC_TYPE), eq(documentEmails.docId, shop.id)))
    .orderBy(desc(documentEmails.updatedAt))
    .limit(1);
  if (existing) {
    if (existing.status === "PENDING" || existing.status === "SENDING" || existing.status === "FAILED") {
      throw conflict("An updated banner for this shop is already on its way.");
    }
    if (Date.now() - existing.updatedAt.getTime() < BANNER_RESEND_COOLDOWN_MINUTES * 60_000) {
      throw conflict(`An updated banner was sent to this shop in the last ${BANNER_RESEND_COOLDOWN_MINUTES} minutes.`);
    }
    await db
      .update(documentEmails)
      .set({
        userId: shop.ownerId,
        subject: email.subject,
        body: email.text,
        status: "PENDING",
        attempts: 0,
        lastError: null,
        toAddress: null,
        sentAt: null,
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(documentEmails.id, existing.id));
    deliverSoon();
    return { toUserId: shop.ownerId };
  }
  // A fresh row (no opt-out check: the admin chose to send it, and it is the shop's own printable banner).
  await db.insert(documentEmails).values({
    docType: BANNER_UPDATE_DOC_TYPE,
    docId: shop.id,
    userId: shop.ownerId,
    recipientRole: "SHOP_OWNER",
    subject: email.subject,
    body: email.text,
    maxAttempts: 5,
  });
  deliverSoon();
  return { toUserId: shop.ownerId };
}

/** Sends at once (tests send explicitly with deliverDocumentEmails(); the cron sweep is the safety net). */
function deliverSoon(): void {
  if (getEnv().NODE_ENV === "test") return;
  void import("@/server/documents/email")
    .then((m) => m.deliverDocumentEmails())
    .catch((error: unknown) => console.error("[welcome-kit] banner update delivery failed", error));
}

/* ------------------------------------------------------------ safety net */

/** Most shops one safety-net run queues (the rest wait for the next run). */
const SAFETY_NET_BATCH = 50;

/**
 * 26-Nov-2026 owner brief: every shop that went live after this release gets the kit, whatever path made it live.
 * Every 15 minutes: live shops approved on or after rule shopWelcomeKit.safetyNetFrom (set by migration 0214 to the
 * moment it ran, so shops that were live before are never e-mailed automatically) that have no SHOP_WELCOME_KIT row
 * are queued — normally none, as every go-live path queues it in its own transaction.
 */
export async function runWelcomeKitSafetyNet(now = new Date()): Promise<{ queued: number; checked: number }> {
  const rule = await getRule("shopWelcomeKit");
  if (!rule.safetyNetEnabled || !rule.safetyNetFrom) return { queued: 0, checked: 0 };
  const from = new Date(rule.safetyNetFrom);
  if (Number.isNaN(from.getTime())) return { queued: 0, checked: 0 };
  const missing = await db
    .select({ id: shops.id, ownerId: shops.ownerId, name: shops.name, slug: shops.slug, state: shops.state, pincode: shops.pincode, ownerName: shops.ownerName })
    .from(shops)
    .where(
      and(
        eq(shops.status, "APPROVED"),
        isNull(shops.deletedAt),
        gte(shops.approvedAt, from),
        lte(shops.approvedAt, now),
        sql`not exists (select 1 from document_emails d where d.doc_type = ${WELCOME_KIT_DOC_TYPE} and d.doc_id = ${shops.id})`,
      ),
    )
    .orderBy(shops.approvedAt)
    .limit(SAFETY_NET_BATCH);
  let queued = 0;
  for (const shop of missing) if (await queueShopWelcomeKit(shop, db, { deliverNow: false })) queued += 1;
  if (queued > 0) console.info(`[welcome-kit] safety net queued ${queued} welcome kit(s)`);
  return { queued, checked: missing.length };
}

/* ------------------------------------------------------------ status */

export interface WelcomeKitStatus {
  status: string;
  toAddress: string | null;
  sentAt: Date | null;
  createdAt: Date;
  lastError: string | null;
}

/** The welcome kit's outbox row per shop (none: never queued). */
export async function welcomeKitStatuses(shopIds: readonly string[], docType: string = WELCOME_KIT_DOC_TYPE): Promise<Map<string, WelcomeKitStatus>> {
  const out = new Map<string, WelcomeKitStatus>();
  if (shopIds.length === 0) return out;
  const rows = await db
    .select({
      docId: documentEmails.docId,
      status: documentEmails.status,
      toAddress: documentEmails.toAddress,
      sentAt: documentEmails.sentAt,
      createdAt: documentEmails.createdAt,
      lastError: documentEmails.lastError,
    })
    .from(documentEmails)
    .where(and(eq(documentEmails.docType, docType), inArray(documentEmails.docId, [...shopIds])));
  for (const { docId, ...row } of rows) if (!out.has(docId)) out.set(docId, row);
  return out;
}

/* ------------------------------------------------------------ files */

/**
 * The shop's banners — English and its local language — as the welcome e-mail, the Marketing download and the
 * admin resend all use them (one renderer, so PNG, PDF and e-mail match). Null when the shop is gone or not live.
 */
export async function shopBannerFiles(shopId: string) {
  const shop = await loadBannerShop(shopId);
  // /shops/<slug> serves approved shops only: a banner for anything else would open a missing page.
  if (!shop || shop.deletedAt || shop.status !== "APPROVED") return null;
  const content = contentFor(shop);
  const upiPayload = upiBannerPayload({ uploadedQr: shop.bannerUpiQr, vpa: shop.upiVpa, shopName: shop.name });
  const banners = await Promise.all(
    (["en", content.local] as const).map(async (lang) => ({
      lang,
      basename: bannerBasename(shop.slug, lang),
      banner: await renderShopBanner({ shopName: shop.name, url: content.shopUrl, lang, ownerName: shop.ownerName, upiPayload }),
    })),
  );
  return { shop, url: content.shopUrl, local: content.local, content, banners };
}

/** Renderer for the outbox (documents/email.ts → renderDocumentAttachments): the welcome kit, or `update` for a resend. */
export async function renderShopWelcomeKit(shopId: string, kind: WelcomeKitContent["kind"] = "welcome"): Promise<RenderedDocument | null> {
  const files = await shopBannerFiles(shopId);
  if (!files) return null;
  const attachments: RenderedDocument["attachments"] = files.banners.flatMap((b) => [
    { filename: `${b.basename}.pdf`, content: b.banner.pdf, contentType: "application/pdf" },
    { filename: `${b.basename}.jpg`, content: b.banner.jpeg, contentType: "image/jpeg", cid: welcomeBannerCid(b.lang) },
  ]);
  // One mail for a new shop (owner, 26-Nov-2026): the welcome kit carries its signed agreements (seller agreements,
  // docs/seller-agreements-2026-11) instead of a second "signed copy" e-mail. Never for the banner update.
  const agreements =
    kind === "welcome"
      ? await import("@/server/legal-agreements/email")
          .then((m) => m.agreementsForWelcomeKit(shopId, attachments.reduce((n, a) => n + a.content.length, 0)))
          .catch((error: unknown) => {
            console.error("[welcome-kit] signed agreements not attached", shopId, error);
            return null;
          })
      : null;
  const html = welcomeKitHtml({ ...files.content, kind });
  return {
    html: agreements ? html.replace(AGREEMENTS_SLOT, agreements.html) : html.replace(AGREEMENTS_SLOT, ""),
    attachments: agreements ? [...attachments, ...agreements.attachments] : attachments,
    ...(agreements ? { text: `${welcomeKitText({ ...files.content, kind })}\n\n${agreements.text}` } : {}),
    ...(agreements?.cc.length ? { cc: agreements.cc } : {}),
  };
}
