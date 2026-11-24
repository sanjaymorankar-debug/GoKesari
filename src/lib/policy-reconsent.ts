/**
 * Policy re-consent (docs/policy-reconsent-2026-11): wording and channel rules
 * shared by the server, the re-consent page and unit tests. No server or
 * database imports.
 */
import { L, type Lang, type Text } from "@/lib/board/i18n";
import { isMobileAppUserAgent } from "@/lib/mobile-app";

export const POLICY_DOC_SLUGS = ["terms", "privacy-policy", "seller-terms"] as const;
export type PolicyDocSlug = (typeof POLICY_DOC_SLUGS)[number];

export const POLICY_DOC_LABEL: Record<PolicyDocSlug, Text> = {
  terms: L("Terms & Conditions", "नियम और शर्तें", "अटी व शर्ती"),
  "privacy-policy": L("Privacy Policy", "गोपनीयता नीति", "गोपनीयता धोरण"),
  "seller-terms": L("Marketplace Seller Terms", "विक्रेता शर्तें", "विक्रेता अटी"),
};

/** The re-consent page's own wording. */
export const RECONSENT_UI = {
  title: L("We have updated our policies", "हमने अपनी नीतियाँ अपडेट की हैं", "आम्ही आमची धोरणे अद्ययावत केली आहेत"),
  intro: L(
    "Please take a moment to read what changed. To keep using GoKesari, accept the new version below.",
    "कृपया एक पल लेकर देखें कि क्या बदला है। GoKesari का उपयोग जारी रखने के लिए नीचे नया संस्करण स्वीकार करें।",
    "कृपया काय बदलले ते एकदा वाचा. GoKesari वापरत राहण्यासाठी खालील नवीन आवृत्ती स्वीकारा.",
  ),
  version: L("Version", "संस्करण", "आवृत्ती"),
  whatChanged: L("What changed", "क्या बदला", "काय बदलले"),
  readFull: L("Read the full document", "पूरा दस्तावेज़ पढ़ें", "संपूर्ण दस्तऐवज वाचा"),
  agree: L(
    "I have read and accept the updated documents above.",
    "मैंने ऊपर दिए अपडेट किए गए दस्तावेज़ पढ़ लिए हैं और स्वीकार करता/करती हूँ।",
    "मी वरील अद्ययावत दस्तऐवज वाचले आहेत आणि ते स्वीकारतो/स्वीकारते.",
  ),
  accept: L("Accept and continue", "स्वीकार करें और आगे बढ़ें", "स्वीकारा आणि पुढे चला"),
  saving: L("Saving…", "सहेजा जा रहा है…", "जतन करत आहे…"),
  signOut: L("Not now — sign out", "अभी नहीं — साइन आउट करें", "आता नाही — साइन आउट करा"),
  failed: L(
    "We could not save your acceptance. Please try again.",
    "आपकी स्वीकृति सहेजी नहीं जा सकी। कृपया फिर से प्रयास करें।",
    "तुमची स्वीकृती जतन झाली नाही. कृपया पुन्हा प्रयत्न करा.",
  ),
  questions: L(
    "Questions? Write to our Grievance Officer from the Grievance Redressal page.",
    "कोई प्रश्न? शिकायत निवारण पेज से हमारे शिकायत अधिकारी को लिखें।",
    "काही प्रश्न? तक्रार निवारण पानावरून आमच्या तक्रार अधिकाऱ्याला लिहा.",
  ),
} as const;

export type PolicySummaryText = { en: string; hi?: string; mr?: string };

/** The change summary in the visitor's language; English when that translation is blank. */
export function summaryIn(summary: PolicySummaryText | null | undefined, lang: Lang): string {
  if (!summary) return "";
  const own = lang === "en" ? summary.en : summary[lang];
  return (own && own.trim()) || summary.en || "";
}

/** Channels a signed-in browser or the app may report; SIGNUP / SHOP_REGISTRATION are server-only. */
export const CLIENT_CHANNELS = ["WEB", "APP", "SHOP_PORTAL", "RIDER_PORTAL", "DEALER_PORTAL", "API"] as const;
export type ClientChannel = (typeof CLIENT_CHANNELS)[number];

/**
 * Where an acceptance was given, from the page it was given on and the user
 * agent. The app (a WebView shell around this site) is always APP; otherwise
 * the portal the path belongs to, else WEB.
 */
export function channelFor(pathname: string | null | undefined, userAgent: string | null | undefined): ClientChannel {
  if (isMobileAppUserAgent(userAgent)) return "APP";
  const path = pathname ?? "";
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  if (under("/shop") || under("/sell")) return "SHOP_PORTAL";
  if (under("/delivery-partner") || under("/gig")) return "RIDER_PORTAL";
  if (under("/dealer") || under("/franchise")) return "DEALER_PORTAL";
  return "WEB";
}

/** Pages the re-consent page never covers: the policies themselves must stay readable. */
export function reconsentExemptPath(pathname: string | null | undefined): boolean {
  const path = pathname ?? "";
  return path === "/legal" || path.startsWith("/legal/") || path === "/grievance" || path.startsWith("/signin");
}

/** Version strings an admin may publish: a date like 2026-12-01, optionally with a suffix (2026-12-01b, 2026-12-01.1). */
export const POLICY_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}([a-z]|\.\d{1,2})?$/;
