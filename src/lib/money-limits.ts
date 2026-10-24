/**
 * Upper bounds for money typed into admin and operator forms (TC-FLD-112,
 * 113, 116, 117) — client-safe, so a form and its API agree. ₹10 crore used
 * to be accepted everywhere; each bound is far above any real figure and the
 * same ₹10,00,000 the registration-fee tiers and shop-wallet adjustments
 * already use (src/server/registration/admin.ts, api/shops/[id]/wallet/adjust).
 */

/** ₹10,00,000 — the common ceiling. */
export const MAX_FORM_AMOUNT_PAISE = 100_000_000;

/** The largest registration fee an admin can set. */
export const MAX_REGISTRATION_FEE_PAISE = MAX_FORM_AMOUNT_PAISE;

/** The largest single shop payment an operator can record. */
export const MAX_SHOP_PAYMENT_PAISE = MAX_FORM_AMOUNT_PAISE;

/** The largest manual finance adjustment, either way (+ owed, − recovered). */
export const MAX_ADJUSTMENT_PAISE = MAX_FORM_AMOUNT_PAISE;

/** The largest single COD cash deposit (it is also limited to the cash held). */
export const MAX_COD_DEPOSIT_PAISE = MAX_FORM_AMOUNT_PAISE;
