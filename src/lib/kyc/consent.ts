/**
 * Wording the seller agrees to before a document is checked (DPDP Act 2023:
 * consent must be specific to a stated purpose, informed and recorded).
 * Shown verbatim next to the checkbox; the version is stored with every
 * consent. Change the text → bump the version, so each stored consent still
 * says which words were agreed to. Client-safe.
 *
 * Needs review by a lawyer before production use — see
 * docs/seller-verification/COMPLIANCE.md.
 */
import { AADHAAR_REFUSED_MESSAGE, looksLikeAadhaar } from "./doc-formats";

export const SELLER_VERIFICATION_CONSENT_VERSION = "2026-10-05";

export const SELLER_VERIFICATION_CONSENT_TEXT =
  "I agree that Gokesari may send this document number to its verification partner, which checks it against " +
  "the government record (Income Tax, GSTN, Udyam, FSSAI or the Labour Department), only to verify my shop for " +
  "selling on Gokesari and to re-check it while my shop is listed. Gokesari keeps the number encrypted and shows " +
  "only a masked form. I can ask for it to be deleted when I stop selling, subject to the legal retention period.";

export const GST_DECLARATION_VERSION = "2026-10-05";

export const GST_DECLARATION_TEXT =
  "I declare that this shop is not registered under GST because its aggregate turnover is below the GST " +
  "registration threshold and it supplies only within its own state through Gokesari. Where the GST law requires " +
  "it, I have obtained an enrolment number on the GST portal for supplying through an e-commerce operator and " +
  "have entered it here. I will register and add my GSTIN if my situation changes. I understand Gokesari will " +
  "review this declaration.";

/**
 * GST portal enrolment number for unregistered sellers supplying through an
 * e-commerce operator (Notification 34/2023-Central Tax, from 1 Oct 2023 —
 * CONFIRM WITH A CA). It has the same 15-character shape as a GSTIN; the
 * check here is shape only.
 */
export function parseGstEnrolmentNumber(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  if (looksLikeAadhaar(raw)) return { ok: false, error: AADHAAR_REFUSED_MESSAGE };
  const value = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[0-9A-Z]{15}$/.test(value)) {
    return { ok: false, error: "The GST enrolment number is 15 letters and digits, as shown on the GST portal." };
  }
  return { ok: true, value };
}
