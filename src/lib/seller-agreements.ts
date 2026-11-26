/** Client-safe constants for the seller agreements screens (docs/seller-agreements-2026-11). */

/** Set by "Remind me later" on the Seller Central blocking screen: the shop id, until the end of the IST day. */
export const AGREEMENTS_LATER_COOKIE = "gk_agreements_later";

/** Pages an owner can always reach while their agreements wait: signing itself and uploading licences. */
export const AGREEMENT_GATE_OPEN_PATHS = ["/shop/agreements", "/shop/legal-documents", "/shop/register", "/shop/join", "/shop/registration-fee"];

export const AGREEMENT_REASON_TEXT = {
  REGISTRATION: "Before paying the registration fee, read and sign your shop's agreements.",
  EXISTING_SHOP: "gokesari.com now asks every shop to sign its personalised Seller agreements, prepared from your shop's own details and licences.",
  NEW_VERSION: "A new version of your agreement has taken effect. Please read it and sign again.",
  ANNEXURE_UPDATE: "Your licences or shop details changed. Please re-confirm the updated Annexure A (licence schedule) with your OTP.",
} as const;
