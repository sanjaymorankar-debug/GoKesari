/**
 * Referral sharing (docs/referral-sharing-2026-11): the link, the channels and the pre-filled
 * message every Share button uses — for dealers, team leads, agents, franchise owners, shops and
 * customers alike. Pure (no server imports), so the client buttons and the tests share it.
 *
 * The link is always /r/<CODE>, with ?c=<channel> so the click is counted against the channel the
 * link was shared on. /r/<CODE> decides where the visitor goes (customer sign-in, Add my shop…).
 */
import type { Lang } from "@/lib/board/i18n";

export const SHARE_CHANNELS = ["whatsapp", "sms", "email", "native", "copy", "qr"] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

/** Short channel tags carried in the link (?c=). */
export const CHANNEL_TAG: Record<ShareChannel, string> = { whatsapp: "wa", sms: "sms", email: "em", native: "sh", copy: "cp", qr: "qr" };
export const CHANNEL_LABEL: Record<ShareChannel, string> = {
  whatsapp: "WhatsApp",
  sms: "SMS",
  email: "Email",
  native: "Share sheet",
  copy: "Copied link",
  qr: "QR code",
};

export function channelFromTag(tag: string | null | undefined): ShareChannel | null {
  const t = (tag ?? "").toLowerCase();
  const found = (Object.entries(CHANNEL_TAG) as [ShareChannel, string][]).find(([, v]) => v === t);
  return found ? found[0] : null;
}

export function isShareChannel(value: unknown): value is ShareChannel {
  return typeof value === "string" && (SHARE_CHANNELS as readonly string[]).includes(value);
}

/** Codes are letters, digits, "-" and "_" (dealer, franchise, shop and customer codes all fit). */
export function cleanShareCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
}

/** https://gokesari.com/r/CODE?c=wa */
export function referralLink(origin: string, code: string, channel?: ShareChannel): string {
  const base = `${origin.replace(/\/$/, "")}/r/${encodeURIComponent(cleanShareCode(code))}`;
  return channel ? `${base}?c=${CHANNEL_TAG[channel]}` : base;
}

/** Who is sharing, which decides the wording: a shop owner is invited to register a shop, a customer to shop. */
export type ShareAudience = "shop-owner" | "customer";

const LOCAL: Record<Exclude<Lang, "en">, Record<ShareAudience, (code: string, who: string) => string>> = {
  hi: {
    "shop-owner": (code, who) => `${who} के रेफ़रल कोड ${code} से अपनी दुकान GoKesari पर रजिस्टर करें:`,
    customer: (code, who) => `${who} ने आपको GoKesari पर बुलाया है — पास की दुकानों से घर तक डिलीवरी। कोड ${code}:`,
  },
  mr: {
    "shop-owner": (code, who) => `${who} यांच्या रेफरल कोड ${code} ने तुमचे दुकान GoKesari वर नोंदवा:`,
    customer: (code, who) => `${who} यांनी तुम्हाला GoKesari वर बोलावले आहे — जवळच्या दुकानांतून घरपोच डिलिव्हरी. कोड ${code}:`,
  },
};

const ENGLISH: Record<ShareAudience, (code: string, who: string) => string> = {
  "shop-owner": (code, who) => `Register your shop on GoKesari with ${who}'s referral code ${code}:`,
  customer: (code, who) => `${who} invited you to GoKesari — local shops delivering to your door. Use code ${code}:`,
};

/**
 * The pre-filled message: English, then the local language (the sharer's language when it is Hindi
 * or Marathi, else Marathi + Hindi is too long for an SMS, so Hindi), then the link.
 */
export function shareMessage(input: { code: string; who: string; audience: ShareAudience; link: string; lang?: Lang | null }): string {
  const code = cleanShareCode(input.code);
  const who = input.who.trim() || "A friend";
  const local: Exclude<Lang, "en"> = input.lang === "mr" ? "mr" : "hi";
  return `${ENGLISH[input.audience](code, who)} ${input.link}\n\n${LOCAL[local][input.audience](code, who)} ${input.link}`;
}

/** The link each channel opens (WhatsApp without a number, the SMS app, the mail app). */
export function channelHref(channel: "whatsapp" | "sms" | "email", message: string, subject = "Join me on GoKesari"): string {
  if (channel === "whatsapp") return `https://wa.me/?text=${encodeURIComponent(message)}`;
  // "?&body=" works on both Android and iOS SMS apps.
  if (channel === "sms") return `sms:?&body=${encodeURIComponent(message)}`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
}
