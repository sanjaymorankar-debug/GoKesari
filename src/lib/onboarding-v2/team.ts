/**
 * Onboarding v2 "My team" (docs/onboarding-v2-2026-11, Flow 4): the pure parts — the search key, the masked
 * name a dealer sees, the invite token and the message shared on WhatsApp / SMS / e-mail. No server imports, so
 * the client and the unit tests share it.
 */
import { channelHref } from "@/lib/referral-share";

export type TeamContact = { kind: "mobile"; e164: string } | { kind: "email"; email: string };

/**
 * What the dealer typed: a 10-digit Indian mobile (spaces, dashes, +91 / 0 allowed) or an e-mail address.
 * Exact match only — null when it is neither.
 */
export function parseTeamContact(raw: string): TeamContact | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value.includes("@")) {
    const email = value.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? { kind: "email", email } : null;
  }
  let digits = value.replace(/[\s()-]/g, "");
  if (digits.startsWith("+91")) digits = digits.slice(3);
  else if (/^91\d{10}$/.test(digits)) digits = digits.slice(2);
  else if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? { kind: "mobile", e164: `+91${digits}` } : null;
}

/** "Ramesh Kumar" → "Ra**** Ku***": enough for the dealer to recognise the person, not to learn the name. */
export function maskPersonName(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "GoKesari customer";
  return words
    .slice(0, 3)
    .map((w) => (w.length <= 2 ? `${w[0]}*` : `${w.slice(0, 2)}${"*".repeat(Math.min(w.length - 2, 6))}`))
    .join(" ");
}

export const TEAM_ROLE_LABEL = { TEAM_LEAD: "Team lead", AGENT: "Agent" } as const;

/** The invitation link the dealer shares: /team/join/<token>. */
export function teamInviteLink(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/team/join/${encodeURIComponent(token)}`;
}

export function teamInviteMessage(input: { dealerName: string; role: "TEAM_LEAD" | "AGENT"; link: string; expiresIst: string }): string {
  const role = input.role === "TEAM_LEAD" ? "a team lead" : "an agent";
  return `${input.dealerName.trim() || "A GoKesari dealer"} invites you to join their GoKesari team as ${role}. Sign in or create your free GoKesari account, then accept: ${input.link} (valid until ${input.expiresIst})`;
}

/** WhatsApp / SMS / e-mail links carrying the invitation message (the referral-sharing channels). */
export function teamInviteShareLinks(message: string): { whatsapp: string; sms: string; email: string } {
  return {
    whatsapp: channelHref("whatsapp", message),
    sms: channelHref("sms", message),
    email: channelHref("email", message, "Join my GoKesari team"),
  };
}
