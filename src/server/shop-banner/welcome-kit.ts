/**
 * docs/shop-welcome-kit-2026-11 — the automatic welcome e-mail with the shop's
 * printable banner (owner request, 20-Nov-2026).
 *
 * The moment a shop goes live (approveShopTransaction: admin / operator
 * approval, automatic approval, instant GST/PAN approval; approveRegistration:
 * paid self-registration) the welcome kit is queued in the same transaction,
 * in the document-email outbox (documents/email.ts): one row per shop and
 * owner, ever, so a shop that is suspended and approved again is not welcomed
 * twice. The outbox sends it just after commit and retries a failed send with
 * backoff (cron every-minute is the safety net); no SMTP or no real e-mail
 * address → SKIPPED, never an error.
 *
 * The banner is drawn at send time (render.ts) from the shop as it is then,
 * so nothing large is stored. The e-mail congratulates and welcomes the owner,
 * shows the banner, attaches it as a print-ready A4 PDF and a full-size PNG,
 * and tells him to print it and put it up at his shop. Queuing never blocks an
 * approval: it runs in a savepoint and a failure is only logged.
 */
import { eq } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { db, type DbClient } from "@/server/db";
import { shops } from "@/server/db/schema";
import { queueDocumentEmail, type RenderedDocument } from "@/server/documents/email";

import {
  BANNER_LANGUAGE_LABEL,
  bannerBasename,
  localBannerLanguage,
  renderShopBanner,
  shopPageUrl,
  type BannerLanguage,
} from "./render";

export const WELCOME_KIT_DOC_TYPE = "SHOP_WELCOME_KIT";
/** The inline banners' Content-IDs in the HTML body. */
export const welcomeBannerCid = (lang: BannerLanguage) => `gk-shop-banner-${lang}`;

function siteBase(): string {
  return (getEnv().AUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
}

export function welcomeKitTitle(shopName: string): string {
  return `Congratulations! ${shopName} is now live on GoKesari`;
}

export const PRINT_STEPS = [
  "Print in COLOUR on a colour page — not black and white. The GoKesari saffron colours are part of the banner.",
  "Print the attached PDFs on A4 paper (landscape, \"Fit to page\"): one banner in English, one in your local language. A print shop can also make them as a sticker or flex board from the same files.",
  "Before you put it up, scan the QR code with your phone: it must open your shop's page on GoKesari.",
  "Put it at your counter or shop entrance at eye level, where every customer can see and scan it. Laminate it to keep it safe from rain and dust.",
  "Tell your customers: \"Scan this to order from our shop on GoKesari.\"",
] as const;

/** One line in the local language, so the owner sees the key instruction in his own language too. */
export const LOCAL_PRINT_LINE: Record<Exclude<BannerLanguage, "en">, string> = {
  mr: "तुमचे GoKesari बॅनर (इंग्रजी आणि मराठी) रंगीत प्रिंट करा आणि दुकानात ग्राहकांना दिसेल अशा ठिकाणी लावा.",
  hi: "अपने GoKesari बैनर (अंग्रेज़ी और हिंदी) रंगीन प्रिंट करें और दुकान में ग्राहकों को दिखे ऐसी जगह लगाएँ।",
};

/** The plain-text part (queued in the outbox; renderEmail adds the title, link and footer). */
export function welcomeKitText(shopName: string, shopUrl: string, local: Exclude<BannerLanguage, "en"> = "hi"): string {
  return [
    `Welcome to GoKesari! Your shop ${shopName} is registered and live — customers near you can now find it and order from it.`,
    `Your two shop banners are attached — English and ${BANNER_LANGUAGE_LABEL[local]} — as print-ready PDFs. Each shows your shop's name and a QR code of your own shop page. Customers who scan it come straight to your shop — no need to search on GoKesari or on Google: ${shopUrl}`,
    `Print them in colour and put them up at your shop:\n${PRINT_STEPS.map((step, i) => `${i + 1}. ${step}`).join("\n")}`,
    LOCAL_PRINT_LINE[local],
    `Next: add your products so customers can order — ${siteBase()}/shop/manage/products`,
    `You can download the banner again at any time from your shop dashboard. Need help? ${siteBase()}/support`,
  ].join("\n\n");
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function welcomeKitHtml(shopName: string, shopUrl: string, local: Exclude<BannerLanguage, "en">): string {
  const name = escapeHtml(shopName);
  const base = siteBase();
  const p = (html: string) => `<p style="color:#44403c;line-height:1.5;margin:0 0 12px">${html}</p>`;
  return (
    `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:600px">` +
    `<h2 style="margin:0 0 8px;color:#1c1917">Congratulations! ${name} is now live on GoKesari</h2>` +
    p(`Welcome to GoKesari! Your shop <strong>${name}</strong> is registered and live — customers near you can now find it and order from it.`) +
    p(`Here are your two shop banners — <strong>English</strong> and <strong>${escapeHtml(BANNER_LANGUAGE_LABEL[local])}</strong>. Each shows your shop's name and a QR code of your own shop page. Customers who scan it come straight to your shop — no need to search on GoKesari or on Google.`) +
    (["en", local] as const)
      .map(
        (lang) =>
          `<p style="margin:0 0 12px"><img src="cid:${welcomeBannerCid(lang)}" alt="Your GoKesari shop banner for ${name} (${escapeHtml(BANNER_LANGUAGE_LABEL[lang])})" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0"></p>`,
      )
      .join("") +
    `<h3 style="margin:16px 0 8px;color:#c2410c">Print them in colour and put them up at your shop</h3>` +
    `<ol style="color:#44403c;line-height:1.5;margin:0 0 12px;padding-left:20px">${PRINT_STEPS.map((step) => `<li style="margin:0 0 6px">${escapeHtml(step)}</li>`).join("")}</ol>` +
    p(`<strong>${escapeHtml(LOCAL_PRINT_LINE[local])}</strong>`) +
    p(`Your shop page: <a href="${escapeHtml(shopUrl)}" style="color:#c2410c">${escapeHtml(shopUrl)}</a>`) +
    `<p style="margin:16px 0"><a href="${base}/shop/manage/products" style="background:#c2410c;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;display:inline-block">Add your products</a></p>` +
    `<p style="color:#78716c;font-size:12px;line-height:1.5;margin:0">You can download the banner again at any time from your shop dashboard. Need help? <a href="${base}/support" style="color:#78716c">${base}/support</a></p>` +
    `</div>`
  );
}

/**
 * Queues the welcome kit for a shop that just went live. Call it inside the
 * approval transaction (pass `tx`): the row commits with the approval. Returns
 * whether a row was queued (false: already welcomed, opted out, or failed).
 */
export async function queueShopWelcomeKit(
  shop: { id: string; ownerId: string; name: string; slug: string; state?: string | null; pincode?: string | null },
  client: DbClient = db,
): Promise<boolean> {
  try {
    // A savepoint: if queuing fails, only it is rolled back — never the approval around it.
    return await client.transaction((sp) =>
      queueDocumentEmail(
        {
          docType: WELCOME_KIT_DOC_TYPE,
          docId: shop.id,
          userId: shop.ownerId,
          recipientRole: "SHOP_OWNER",
          title: welcomeKitTitle(shop.name),
          body: welcomeKitText(shop.name, shopPageUrl(shop.slug), localBannerLanguage(shop)),
          actionUrl: "/shop",
          category: "SHOP",
        },
        sp,
      ),
    );
  } catch (error) {
    console.error("[welcome-kit] could not queue", shop.id, error instanceof Error ? error.message : error);
    return false;
  }
}

/** The shop's banners — English and its local language (also used by the dashboard download). Null when the shop is gone or not live. */
export async function shopBannerFiles(shopId: string) {
  const [shop] = await db
    .select({ id: shops.id, name: shops.name, slug: shops.slug, status: shops.status, deletedAt: shops.deletedAt, state: shops.state, pincode: shops.pincode })
    .from(shops)
    .where(eq(shops.id, shopId));
  // /shops/<slug> serves approved shops only: a banner for anything else would open a missing page.
  if (!shop || shop.deletedAt || shop.status !== "APPROVED") return null;
  const url = shopPageUrl(shop.slug);
  const local = localBannerLanguage(shop);
  const banners = await Promise.all(
    (["en", local] as const).map(async (lang) => ({
      lang,
      basename: bannerBasename(shop.slug, lang),
      banner: await renderShopBanner({ shopName: shop.name, url, lang }),
    })),
  );
  return { shop, url, local, banners };
}

/** Renderer for the outbox (documents/email.ts → renderDocumentAttachments). */
export async function renderShopWelcomeKit(shopId: string): Promise<RenderedDocument | null> {
  const files = await shopBannerFiles(shopId);
  if (!files) return null;
  return {
    html: welcomeKitHtml(files.shop.name, files.url, files.local),
    attachments: files.banners.flatMap((b) => [
      { filename: `${b.basename}.pdf`, content: b.banner.pdf, contentType: "application/pdf" },
      { filename: `${b.basename}.jpg`, content: b.banner.jpeg, contentType: "image/jpeg", cid: welcomeBannerCid(b.lang) },
    ]),
  };
}
