/**
 * Module 3: accounts created at shop self-registration from a mobile number
 * alone get a placeholder email (users.email is required and unique) on a
 * reserved domain no mail can reach. Nothing is ever emailed to it; the owner
 * can add a real address when completing the profile.
 */
export const PLACEHOLDER_EMAIL_DOMAIN = "no-email.gokesari.invalid";

export function placeholderEmailFor(mobileE164: string): string {
  return `m${mobileE164.replace(/\D/g, "")}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return Boolean(email && email.toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`));
}
