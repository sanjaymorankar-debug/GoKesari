/** F11: cookie holding a referral code from a /r/CODE link until the visitor signs in. */
export const REFERRAL_COOKIE = "gk_ref";
/**
 * Referral sharing (docs/referral-sharing-2026-11): the first valid /r/ link opened on this browser,
 * any kind (customer, shop, dealer, franchise). "First valid link wins" and "Referred by <name>" read it.
 */
export const REFERRAL_LINK_COOKIE = "gk_ref_link";
/** The app's deferred-link click (/app-open) waiting to be recorded against the account that signs in. */
export const REFERRAL_CLAIM_COOKIE = "gk_ref_claim";
