/**
 * Feature flags (docs/dealer-programme, step 1): the admin switches for the
 * dealer programme.
 *
 *   dealer_programme_enabled                dealers, codes, leads, commission (per district)
 *   gov_verification_auto_approval_enabled  instant shop approval on GST/PAN + payment
 *   dealer_rating_bonus_enabled             rating-linked commission bonus
 *   paid_support_services_enabled           the paid Support Services page
 *
 * Stored in `feature_flags` (seeded OFF by migration 0102). Reads are cached
 * for CACHE_MS per process, like `platform_settings` (settings.ts): a change
 * made through `setFeatureFlag` clears this process's cache, so it takes effect
 * on its next request; other processes see it within CACHE_MS. With every
 * flag off the site behaves exactly as before: new routes answer "not
 * available" (`requireFeature`) and no existing path changes.
 *
 * A flag can be limited to districts (geo_areas codes): `districtCodes` NULL
 * means every district. `isFeatureEnabled(key, { districtCode })` is true only
 * when the flag is on and covers that district; without a district it asks
 * "is it on anywhere".
 *
 * Only an ADMIN may change a flag (checked here, not only in the route), a
 * reason is required, and every change is written to `feature_flag_changes`
 * and the audit log.
 */
import { stateCodeOfArea } from "@/lib/indian-states";
import { desc, eq, sql } from "drizzle-orm";

import { AppError, forbidden, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  FEATURE_FLAG_KEYS,
  featureFlagChanges,
  featureFlags,
  shops,
  type FeatureFlagKey,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { districtCodeForPincode, listDistricts, listStates } from "./geo-areas";

/**
 * Flags no longer switched from Admin → Feature flags (owner brief 08-Nov-2026: one shop
 * registration flow). The wizard is the only way to register a shop and instant approval
 * always applies; the keys stay in the schema so old rows and the change log still read.
 */
export const RETIRED_FEATURE_FLAGS: readonly FeatureFlagKey[] = ["shop_onboarding_wizard_enabled", "gov_verification_auto_approval_enabled"];

export const FEATURE_FLAG_LABELS: Record<FeatureFlagKey, string> = {
  dealer_programme_enabled: "Dealer programme",
  gov_verification_auto_approval_enabled: "Instant approval on GST/PAN verification + payment",
  dealer_rating_bonus_enabled: "Dealer rating bonus",
  paid_support_services_enabled: "Paid support services",
  shop_onboarding_wizard_enabled: "Shop onboarding wizard",
  rider_bank_account_enabled: "Rider bank account",
  rider_withdrawal_enabled: "Rider withdrawals to bank",
  rider_monthly_payout_enabled: "Rider monthly payout (5th)",
  billing_v2: "Billing v2: tax engine and money flow",
  tcs_engine: "GST TCS (s.52) engine and GSTR-8",
  tds_engine: "Income-tax TDS (s.393) engine",
  delivery_9_5: "GST on delivery fees under s.9(5)",
  gsp_live: "Live GST portal connection (GSP)",
  einvoice: "E-invoicing (IRN) through the GSP",
  ewaybill: "E-way bills through the GSP",
  tally_connector: "TallyPrime connector",
  zoho_connector: "Zoho Books connector",
  odoo_connector: "Odoo connector",
  ondc_mode: "ONDC seller-side mode",
  society_rider_join_requests_enabled: "Riders ask to join a society",
  shop_logo_upload_enabled: "Shop logo upload (shop owners)",
  shop_welcome_kit_admin_send_enabled: "Send welcome kit to existing shops",
  smart_list_scan_enabled: "Scan my shopping list (photo → wishlist → compare shops)",
  shop_photo_listing_enabled: "Add product by photo + voice (shop owners)",
  whatsapp_shop_orders_enabled: "New orders on the shop owner's WhatsApp",
  voice_price_assistant_enabled: "Change prices and offers by voice (shop owners)",
  rbac_v2_staff_roles: "Staff roles: CA, Accountant, Support and Operations boards",
  rbac_v2_four_eye_admin: "Two-admin approval for user, role, suspension and flag changes",
  rbac_v2_accounting: "Accounting: journal entries, period close, rate proposals",
  tax_register: "Tax register: Accountant proposes, CA approves tax settings",
  payout_deductions: "TDS / TCS withheld on every payout (riders, referrals, services)",
  rbac_v2_support: "Support desk: manager queue and Support Users",
  rbac_v2_shop_change_requests: "Support-proposed shop changes approved by the shop owner",
  rbac_v2_operations: "Operations: tasks, zones, onboarding reports",
  dealer_platform_four_eye: "Dealer schemes: second approver for publishing, scheme changes and refunds",
  shop_staff_roles_enabled: "Shop staff roles and permissions",
  whatsapp_customer_enabled: "Customer updates and shopping on WhatsApp",
  brand_barcode_favourites_enabled: "Customers: brand search, barcode search and favourites",
  onboarding_referral_by_pin_enabled: "Shop registration: find a referral code by PIN code",
  onboarding_assisted_mode_enabled: "Shop registration: dealer / operator fills in the wizard for the owner",
  onboarding_scan_first_enabled: "Shop registration: open the document scan first on phones",
  guest_cart_enabled: "Guests can fill a cart; sign-in only at Place order",
  hdms_enabled: "Delivery management: allocation engine and delivery partners (Shadowfax, Pidge, Porter, Borzo)",
  guest_checkout_enabled: "Guest checkout: order with a one-time code, track without signing in",
  account_self_deletion_enabled: "Self-service account deletion from My Profile",
  identity_verification_customers_enabled: "Customers: verify identity before first checkout",
  identity_verification_shop_owners_enabled: "Shop owners: verify identity before going live / accepting orders",
};

export const FEATURE_FLAG_HINTS: Record<FeatureFlagKey, string> = {
  dealer_programme_enabled:
    "Dealer applications, dealer and salesperson codes, leads, dealer-assisted registration and dealer commission. Limit it to the pilot districts.",
  gov_verification_auto_approval_enabled:
    "A shop is approved without an admin step when its GSTIN or PAN is verified with the government source, the name matches and the gateway confirms the registration fee. Otherwise it waits for admin approval as today.",
  dealer_rating_bonus_enabled:
    "Each 0.5 of a dealer's rating above 5.0 adds 0.5% to their commission, from the next accrual. Off: every dealer earns the base rate.",
  paid_support_services_enabled:
    "The Support Services page for shop owners: general support, product upload and price update, with the charges set by an admin.",
  shop_onboarding_wizard_enabled:
    "Add my shop opens the step-by-step wizard (owner brief 08-Nov-2026: verify GST or PAN with the referral code → owner name if the record has none → confirm address → map pin → shop name → pay → live → Add Products). Nothing goes on until the GSTIN or PAN is verified; a verified shop goes live right after payment in every district. Off: the long form for everyone, and the wizard's steps are refused; only an admin can open the wizard, at /shop/register?wizard=1, for testing.",
  rider_bank_account_enabled:
    "Delivery partners add and verify their bank account under My wallet (the same personal account customers use for refunds). Changing or removing a verified account needs an emailed code.",
  rider_withdrawal_enabled:
    "Delivery partners withdraw unpaid earnings to their verified bank account, with an emailed code each time; limits, fee and TDS from rule riderPayouts. Needs the rider bank account flag.",
  rider_monthly_payout_enabled:
    "On the 5th at 09:00 IST every eligible delivery partner (approved, verified bank account, above the minimum) is paid what is still unpaid for the previous month. Weekly payouts carry on as before.",
  billing_v2:
    "Each delivered order records how the customer paid, how it reached them and who received the money (rule billing), with the TCS / TDS / delivery-GST decision for that day (docs/billing). Off: nothing is recorded and billing works as before.",
  tcs_engine:
    "GST TCS under s.52 worked out from the money-flow record (net of returns), the per-shop TCS ledger and GSTR-8. Needs billing_v2. Off: payouts keep today's TCS lines.",
  tds_engine:
    "Income-tax TDS under s.393(1) (ex-194O) from the money-flow record, with the quarterly statement data. Needs billing_v2. Off: payouts keep today's TDS lines.",
  delivery_9_5:
    "GoKesari pays GST under s.9(5) on delivery fees of unregistered GoKesari delivery partners, at the dated rate (Admin → Statutory, GST_S95_LOCAL_DELIVERY: 18% to 31 Oct 2026, 5% from 1 Nov 2026). Needs billing_v2. Keep off until the CA confirms.",
  gsp_live:
    "Shops connect their GSTIN through the licensed GST Suvidha Provider and GoKesari talks to the real GST portal. Needs GSP credentials. Off: the in-process mock / manual JSON fallback.",
  einvoice: "IRNs for B2B invoices of shops above the e-invoice turnover, through the GSP. Needs gsp_live.",
  ewaybill: "E-way bills for consignments above the threshold, through the GSP. Needs gsp_live.",
  tally_connector: "Two-way sync with TallyPrime (files for every shop; the GoKesari Tally Connector app for live sync).",
  zoho_connector: "Two-way sync with Zoho Books over its API (OAuth per shop).",
  odoo_connector: "Two-way sync with Odoo over its API.",
  ondc_mode: "GoKesari as the seller-side app on ONDC: TCS when GoKesari releases the payment (Circular 194/06/2023).",
  society_rider_join_requests_enabled:
    "docs/delta CF-006: an approved rider asks to join a verified society's authorised rider list (Delivery partner → Societies); the society admin approves or declines on the society page. Approval lists the rider exactly as adding them by mobile number does. Checked by the society's district. Off: no page or list, the API answers 404; riders already listed stay listed.",
  shop_logo_upload_enabled:
    "docs/delta CF-011 (D-144): shop owners upload or remove their shop logo (JPEG, PNG or WebP) under My Shop → Open or close the shop, hours and contact. The logo shows on the shop card. Off: no upload box; a logo set before stays.",
  shop_welcome_kit_admin_send_enabled:
    "Admin → Shops → Send welcome kit: e-mail the welcome kit (the shop's two printable QR banners) to shops that went live before it existed — one shop, or every live shop of a city or district (preview first). Each shop gets it once, ever. New shops get it automatically whether this is on or off. Tell the owner before a bulk run on gokesari.com.",
  smart_list_scan_enabled:
    "Customers photograph a handwritten or printed shopping list; AI reads it (any Indian language), the customer checks the wishlist, compares nearby shops' prices and orders from one shop. Provider, radius and photo retention: rule smartShopping. Needs an AI key on the server.",
  shop_photo_listing_enabled:
    "Shop owners add a product from 1–4 photos plus price/stock by voice or typing; AI fills the details, the master catalogue is checked first (no duplicates) and new products go to admin review as today.",
  whatsapp_shop_orders_enabled:
    "Each new order is sent to the shop's verified WhatsApp numbers with Accept / Reject buttons; the first action wins. Needs the Meta WhatsApp Cloud API keys and approved templates (rule whatsappShopOrders). Each shop also switches it on in its WhatsApp settings.",
  voice_price_assistant_enabled:
    "Shop owners say or type a product (or scan its barcode) and the new price or offer, in any Indian language; GoKesari shows what it understood and publishes only after the owner says yes. Default offer length: rule voicePriceAssistant. AI (rule smartShopping) is used only when the built-in reader cannot follow the sentence.",
  rbac_v2_staff_roles:
    "docs/rbac: the staff board at /staff for the CA, Accountant, Support Manager, Support User, Operations Manager and Operations User roles. Off: those roles see the site as a customer (the CA keeps its statutory pages). Limit it to some roles with the role scope.",
  rbac_v2_four_eye_admin:
    "docs/rbac: role changes, suspensions, reactivations and flag changes made by one admin wait for a different admin to approve (Admin → Approvals). While fewer than two admins are active, the Super Admin may approve alone; each such approval is marked and e-mailed. Emergency suspension still applies at once and must be confirmed within 24 hours. Off: every admin acts alone, as today.",
  rbac_v2_accounting: "docs/rbac Phase 3: Accountant drafts → CA approves journal entries; periods; Accountant → CA → Admin rate changes. Existing rate screens are unchanged.",
  tax_register:
    "docs/tax-register: the Accountant proposes changes to tax settings (statutory TCS / TDS rows, TDS on commission, GST rules, HSN rates, product GST, tax fields of the settings) and answers questions for the CA; the CA approves (never their own) and the change is applied. On: those settings are changed only through the register (direct edits on the admin screens are refused). Off: the register screens work, and the admin screens edit directly as today.",
  payout_deductions:
    "docs/tax-register/PAYOUT_DEDUCTIONS.md: weekly rider payouts deduct TDS s.194C (rule riderPayouts), referral commissions deduct TDS s.194H (statutory row IT_TDS_194H) when paid, and the payout cycle deducts TDS s.194-O (and TCS where the CA's row covers services) on appointment, rental and prescription earnings. Shops are then paid only through the payout cycle (the weekly shop settlement refuses). On gokesari.com a deduction whose rate the CA has not approved holds the payout. Off: as before.",
  rbac_v2_support: "docs/rbac Phase 4: the Support Manager's queue and the Support User's assigned work.",
  rbac_v2_shop_change_requests: "docs/rbac Phase 5: changes proposed by Support wait for the shop owner's approval item by item; nothing is applied until approved.",
  rbac_v2_operations: "docs/rbac Phase 6–7: Operations tasks, zones, customer assists, onboarding reports and the handover to Support.",
  dealer_platform_four_eye: "docs/dealer-platform Phase 6: publishing a scheme version, changing a scheme's status, moving a dealer to another scheme and refunding a franchise booking wait for a second approver in Admin → Approvals (never the requester).",
  shop_staff_roles_enabled:
    "docs/shop-staff-roles-2026-11: shop owners invite staff with a role (manager, orders, billing, stock, delivery, support, catalogue or custom) and the server checks each permission on orders, stock, catalogue, billing, delivery, reports and settings. Off: staff can only edit product photos and descriptions, as before.",
  whatsapp_customer_enabled:
    "docs/customer-whatsapp-2026-11: customers opt in to WhatsApp updates on My Profile (or by sending START; STOP opts out). Order placed / accepted, payment received, status changes, out for delivery, delivered, cancelled, refund issued and subscription renewal reminders go out as the approved templates named in rule whatsappCustomer (which must also be enabled). Customers can also search, pick, set a quantity and get a signed checkout link by chat. Needs the Meta keys (WHATSAPP_PROVIDER=meta); on the test site WHATSAPP_PROVIDER=mock writes every message to Admin → Test messages instead. Off: nothing changes.",
  brand_barcode_favourites_enabled:
    "docs/search-brand-barcode-favourites-2026-11: search finds products by brand name, the search box suggests brands and each brand has a page (/brand/…); customers scan or type a product barcode in the search box; customers save products with a heart and see them, with the lowest price nearby, on /favourites (guests' hearts stay in the browser and move to the account at sign-in). Off: none of it shows and its APIs answer 404.",
  onboarding_referral_by_pin_enabled:
    "docs/onboarding-waves-2-3-2026-11 (WP6): on the wizard's first screen an owner without a referral code types the shop's PIN code and sees the approved dealers who cover that area (closest area first), with their active code to tap and use; the dealer's phone is shown only to a signed-in user. Rate-limited. Off: the panel is hidden and GET /api/referral-codes/by-pincode answers 404.",
  onboarding_assisted_mode_enabled:
    "docs/onboarding-waves-2-3-2026-11 (WP7): a dealer, dealer employee or operator who holds a valid owner-consent session (the owner's one-time code) fills in the registration wizard for the owner. The draft records who helped, the helper's referral code is locked onto it and the owner pays the fee by a link / QR on their own phone. Every assisted step is in the audit log. Off: the wizard is the owner's alone, as today; the dealer and operator flat forms are unchanged either way.",
  onboarding_scan_first_enabled:
    "docs/onboarding-waves-2-3-2026-11 (WP10): on a phone the wizard's Verify screen opens the GST / PAN photo scan first and loads the reading model in the background. Typing the number stays one tap away. Off: the scan stays folded as today.",
  guest_cart_enabled:
    "docs/guest-cart-2026-11 (owner, 23-Nov-2026): a shopper who is not signed in can tap Add to cart and open the cart. The guest cart is kept only in their browser (up to 50 items, 7 days); nothing is saved on the server. Place order asks them to sign in, then moves the items into their account cart (quantities added, capped at stock) and returns to checkout. Off: Add to cart asks for sign-in first, as before.",
  hdms_enabled:
    "docs/hdms-2026-11: when no shop rider or GoKesari rider takes a ready order, the allocation engine books an enabled delivery partner (Admin → Delivery management). Off: dispatch works exactly as before; the admin pages stay readable.",
  guest_checkout_enabled:
    "docs/guest-checkout-2026-11: needs guest_cart_enabled ON too. A guest checks out from the cart with name, mobile, e-mail and address and a one-time code (e-mail; plus a mobile code where SMS is set up — mock on the test site). That makes a normal customer account (marked guest-created), signs them in and continues to the usual payment choice. Adds: tracking links without sign-in (/track), the combined timeline on multi-shop orders, the \"Best shop for this cart\" panel and Admin → Payments → Order-group reconciliation. Off: the site behaves as before.",
  account_self_deletion_enabled: "docs/account-deletion-2026-11: a signed-in person deletes their own account (My Profile → Delete my account) after the checks pass and an emailed code. The account is hidden at once (signed out everywhere, not shown to anyone else; admins see it \"Under cooling period\" with the reason) and anonymised after the cooling-off period (rule accountDeletion.coolingOffDays, 90 days) by the daily job; signing in again with an emailed code during that time offers to restore it. Orders, invoices, payments and ledgers are kept for legal retention (rule accountDeletion.retentionYears). Off: the section is hidden and the APIs answer 404; accounts already in their cooling-off period can still be restored and are still purged when due.",
  identity_verification_customers_enabled:
    "docs/identity-verification-2026-11 (Admin → Identity verification): customers verify their identity once, before their first order — Aadhaar shared from DigiLocker through the licensed KYC provider, or PAN instead (Aadhaar is voluntary). Only the last four digits, the verified name, the method and the provider reference are kept. Legal advice is pending: keep off on gokesari.com until it is given. On test.gokesari.com the mock provider is always used. Off: no customer is asked or blocked; verifications already done are kept.",
  identity_verification_shop_owners_enabled:
    "docs/identity-verification-2026-11 (Admin → Identity verification): a new shop goes live only once its owner's identity is verified; an existing owner is asked at sign-in and has rule identityVerification.sellerGraceDays from the first time they are asked after this was switched on, then their shops take no new orders until they verify (orders already accepted are unaffected). Legal advice is pending. Off: no shop owner is asked or blocked, no banner; verifications already done are kept.",
};

export interface FeatureFlagView {
  key: FeatureFlagKey;
  enabled: boolean;
  /** NULL = every district. */
  districtCodes: string[] | null;
  /** docs/rbac: NULL = every role. */
  roleScope?: string[] | null;
  updatedAt: Date | null;
}

export interface FeatureFlagChangeView {
  id: string;
  flagKey: FeatureFlagKey;
  oldValue: { enabled: boolean; districtCodes: string[] | null };
  newValue: { enabled: boolean; districtCodes: string[] | null };
  reason: string;
  changedByEmail: string | null;
  changedByRole: string | null;
  changedAt: Date;
}

const OFF = (key: FeatureFlagKey): FeatureFlagView => ({ key, enabled: false, districtCodes: null, updatedAt: null });

type FlagMap = Record<FeatureFlagKey, FeatureFlagView>;

const CACHE_MS = 15_000;
let cache: { at: number; flags: FlagMap } | null = null;
/** The one read in progress, shared by everyone who missed the cache. */
let inflight: Promise<FlagMap> | null = null;
/** Bumped by every write, so a read that started before it cannot cache the old value. */
let generation = 0;

/** Every flag. A missing row, or a table that cannot be read, counts as OFF. */
export async function getFeatureFlags(): Promise<FlagMap> {
  if (cache && Date.now() - cache.at < CACHE_MS) return { ...cache.flags };
  if (!inflight) inflight = readFlags().finally(() => (inflight = null));
  return { ...(await inflight) };
}

async function readFlags(): Promise<FlagMap> {
  const startedAt = generation;
  const out = Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, OFF(key)])) as FlagMap;
  try {
    const rows = await db.select().from(featureFlags);
    for (const row of rows) {
      if ((FEATURE_FLAG_KEYS as readonly string[]).includes(row.key)) {
        out[row.key] = { key: row.key, enabled: row.enabled, districtCodes: row.districtCodes ?? null, roleScope: row.roleScope ?? null, updatedAt: row.updatedAt };
      }
    }
  } catch (error) {
    // Not cached: the next request tries the table again.
    console.error("[feature-flags] read failed, treating every flag as off", error);
    return out;
  }
  if (generation === startedAt) cache = { at: Date.now(), flags: out };
  return out;
}

/** Forget cached flags (after a write; tests that write `feature_flags` directly call it too). */
export function clearFeatureFlagCache(): void {
  cache = null;
  inflight = null;
  generation += 1;
}

export async function getFeatureFlag(key: FeatureFlagKey): Promise<FeatureFlagView> {
  return (await getFeatureFlags())[key];
}

/** Keys of the flags that are on anywhere (for menus: an entry of a feature that is off is hidden). */
export async function enabledFeatureKeys(): Promise<FeatureFlagKey[]> {
  return Object.values(await getFeatureFlags())
    .filter((f) => f.enabled)
    .map((f) => f.key);
}

/** True when the flag's district list covers this district (NULL list = every district). */
export function flagCoversDistrict(flag: Pick<FeatureFlagView, "enabled" | "districtCodes">, districtCode: string | null | undefined): boolean {
  if (!flag.enabled) return false;
  if (flag.districtCodes === null) return true;
  if (districtCode == null) return false;
  // The list may name whole states ("KA") as well as districts ("MH-PUN").
  const state = stateCodeOfArea(districtCode);
  return flag.districtCodes.includes(districtCode) || (state != null && flag.districtCodes.includes(state));
}

/**
 * Is the feature on? With `districtCode` (or `null` for "a shop whose district
 * is unknown"): on for that district. Without the option: on anywhere.
 */
export async function isFeatureEnabled(key: FeatureFlagKey, options: { districtCode?: string | null } = {}): Promise<boolean> {
  const flag = await getFeatureFlag(key);
  if (!("districtCode" in options)) return flag.enabled;
  return flagCoversDistrict(flag, options.districtCode);
}

/**
 * Is the feature on for this shop? The district of its PIN code decides (QA D-110: a flag limited
 * to pilot districts must not reach every shop). The shop is read only when the flag is on and
 * limited, so a flag that is off or on everywhere costs nothing more. A shop that cannot be found,
 * or whose PIN is not mapped, counts as outside every listed district.
 */
export async function isFeatureEnabledForShop(key: FeatureFlagKey, shop: string | { pincode: string | null }): Promise<boolean> {
  return flagCoversShop(await getFeatureFlag(key), shop);
}

/** `isFeatureEnabledForShop` for a flag already read (one read for many shops). */
export async function flagCoversShop(flag: Pick<FeatureFlagView, "enabled" | "districtCodes">, shop: string | { pincode: string | null }): Promise<boolean> {
  if (!flag.enabled) return false;
  if (flag.districtCodes === null) return true;
  const pincode = typeof shop === "string" ? (await db.select({ pincode: shops.pincode }).from(shops).where(eq(shops.id, shop)))[0]?.pincode : shop.pincode;
  return flagCoversDistrict(flag, await districtCodeForPincode(pincode));
}

/** Throws "not available" unless the flag is on for this shop's district. */
export async function requireFeatureForShop(key: FeatureFlagKey, shop: string | { pincode: string | null }): Promise<void> {
  if (!(await isFeatureEnabledForShop(key, shop))) throw featureNotAvailable(key);
}

/** Keys of the flags that are on for this shop's district (the shop's menus and tiles). */
export async function enabledFeatureKeysForShop(shop: string | { pincode: string | null }): Promise<FeatureFlagKey[]> {
  const flags = Object.values(await getFeatureFlags());
  const on = await Promise.all(flags.map((f) => flagCoversShop(f, shop)));
  return flags.filter((_, i) => on[i]).map((f) => f.key);
}

/** Error for a route of a feature that is switched off: 404, so the site looks as it did before. */
export function featureNotAvailable(key: FeatureFlagKey): AppError {
  return new AppError("NOT_FOUND", "This feature is not available.", { reason: "FEATURE_NOT_AVAILABLE", feature: key });
}

/** docs/rbac: is the flag on for this role? Off, or on with a role scope that does not name the role → false. */
export function flagCoversRole(flag: Pick<FeatureFlagView, "enabled" | "roleScope">, role: UserRole): boolean {
  if (!flag.enabled) return false;
  if (flag.roleScope == null) return true;
  return flag.roleScope.includes(role);
}

export async function isFeatureEnabledForRole(key: FeatureFlagKey, role: UserRole): Promise<boolean> {
  return flagCoversRole(await getFeatureFlag(key), role);
}

/** Throws "not available" unless the flag is on for this role. */
export async function requireFeatureForRole(key: FeatureFlagKey, role: UserRole): Promise<void> {
  if (!(await isFeatureEnabledForRole(key, role))) throw featureNotAvailable(key);
}

/**
 * docs/rbac: limit a flag to some roles (NULL = every role). ADMIN only, reason required, logged in
 * feature_flag_changes and the audit log like any other flag change.
 */
export async function setFeatureFlagRoleScope(
  key: FeatureFlagKey,
  roleScope: UserRole[] | null,
  reason: string,
  actor: { id: string; role: UserRole; email?: string | null },
): Promise<{ changed: boolean }> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change feature flags.");
  if (!(FEATURE_FLAG_KEYS as readonly string[]).includes(key)) throw validationFailed("Unknown feature flag.");
  const why = reason.trim();
  if (why.length < 5) throw validationFailed("Say why you are changing this flag.", { fields: { reason: "Give a reason (at least 5 characters)." } });
  const next = roleScope === null ? null : [...new Set(roleScope)].sort();
  if (next !== null && next.length === 0) throw validationFailed("Choose at least one role, or every role.");
  const changed = await db.transaction(async (tx) => {
    await tx.insert(featureFlags).values({ key, enabled: false }).onConflictDoNothing();
    const [current] = await tx.select().from(featureFlags).where(eq(featureFlags.key, key)).for("update");
    const before = current.roleScope ?? null;
    if (JSON.stringify(before) === JSON.stringify(next)) return false;
    const now = new Date();
    await tx.update(featureFlags).set({ roleScope: next, updatedBy: actor.id, updatedAt: now }).where(eq(featureFlags.key, key));
    const state = { enabled: current.enabled, districtCodes: current.districtCodes ?? null };
    await tx.insert(featureFlagChanges).values({
      flagKey: key,
      oldValue: { ...state, roleScope: before } as typeof state,
      newValue: { ...state, roleScope: next } as typeof state,
      reason: why,
      changedBy: actor.id,
      changedByEmail: actor.email ?? null,
      changedByRole: actor.role,
      changedAt: now,
    });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.FEATURE_FLAG_CHANGED,
        entityType: "feature_flag",
        entityId: key,
        previousValue: { roleScope: before },
        newValue: { roleScope: next, reason: why },
      },
      tx,
    );
    return true;
  });
  if (changed) clearFeatureFlagCache();
  return { changed };
}

/** Throws "not available" unless the flag is on (for the district, when given). */
export async function requireFeature(key: FeatureFlagKey, options: { districtCode?: string | null } = {}): Promise<void> {
  if (!(await isFeatureEnabled(key, options))) throw featureNotAvailable(key);
}

/**
 * Changes one flag. ADMIN only, a reason of at least 5 characters, and area
 * codes that are active STATE or DISTRICT rows of geo_areas — a whole state
 * ("KA") or a district ("MH-PUN") — (an empty list is refused —
 * switch the flag off instead). Saving the value it already has changes and
 * logs nothing.
 */
export async function setFeatureFlag(
  key: FeatureFlagKey,
  value: { enabled: boolean; districtCodes: string[] | null },
  reason: string,
  actor: { id: string; role: UserRole; email?: string | null },
): Promise<{ flag: FeatureFlagView; changed: boolean }> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change feature flags.");
  if (!(FEATURE_FLAG_KEYS as readonly string[]).includes(key)) throw validationFailed("Unknown feature flag.");
  if (RETIRED_FEATURE_FLAGS.includes(key)) throw validationFailed("This flag is retired: shop registration has one flow, always on.");
  const why = reason.trim();
  if (why.length < 5) throw validationFailed("Say why you are changing this flag.", { fields: { reason: "Give a reason (at least 5 characters)." } });

  let districtCodes: string[] | null = null;
  if (value.districtCodes !== null) {
    const wanted = [...new Set(value.districtCodes.map((c) => c.trim().toUpperCase()).filter(Boolean))].sort();
    if (wanted.length === 0) {
      throw validationFailed("Choose at least one state or district, or all of India.", { fields: { districtCodes: "Choose at least one state or district." } });
    }
    const known = new Set([...(await listStates()), ...(await listDistricts())].filter((d) => d.status === "ACTIVE").map((d) => d.code));
    const unknown = wanted.filter((c) => !known.has(c));
    if (unknown.length) {
      throw validationFailed(`Unknown state or district: ${unknown.join(", ")}.`, { fields: { districtCodes: "Choose states or districts from the list." } });
    }
    districtCodes = wanted;
  }
  const next = { enabled: value.enabled, districtCodes };

  const result = await db.transaction(async (tx) => {
    // Locked so two admins switching at once log two clean changes.
    await tx.insert(featureFlags).values({ key, enabled: false }).onConflictDoNothing();
    const [current] = await tx.select().from(featureFlags).where(eq(featureFlags.key, key)).for("update");
    const old = { enabled: current.enabled, districtCodes: current.districtCodes ?? null };
    if (old.enabled === next.enabled && JSON.stringify(old.districtCodes) === JSON.stringify(next.districtCodes)) {
      return { flag: { key, ...old, updatedAt: current.updatedAt }, changed: false };
    }
    const now = new Date();
    await tx
      .update(featureFlags)
      .set({ enabled: next.enabled, districtCodes: next.districtCodes, updatedBy: actor.id, updatedAt: now })
      .where(eq(featureFlags.key, key));
    await tx.insert(featureFlagChanges).values({
      flagKey: key,
      oldValue: old,
      newValue: next,
      reason: why,
      changedBy: actor.id,
      changedByEmail: actor.email ?? null,
      changedByRole: actor.role,
      changedAt: now,
    });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.FEATURE_FLAG_CHANGED,
        entityType: "feature_flag",
        entityId: key,
        previousValue: old,
        newValue: { ...next, reason: why },
      },
      tx,
    );
    return { flag: { key, ...next, updatedAt: now }, changed: true };
  });
  // After the commit, so the next read in this process sees the new value.
  if (result.changed) clearFeatureFlagCache();
  return result;
}

/** The most recent changes, newest first (all flags, or one). */
export async function listFeatureFlagChanges(options: { key?: FeatureFlagKey; limit?: number } = {}): Promise<FeatureFlagChangeView[]> {
  const rows = await db
    .select()
    .from(featureFlagChanges)
    .where(options.key ? eq(featureFlagChanges.flagKey, options.key) : sql`true`)
    .orderBy(desc(featureFlagChanges.changedAt))
    .limit(Math.min(options.limit ?? 20, 200));
  return rows.map((r) => ({
    id: r.id,
    flagKey: r.flagKey,
    oldValue: r.oldValue,
    newValue: r.newValue,
    reason: r.reason,
    changedByEmail: r.changedByEmail,
    changedByRole: r.changedByRole,
    changedAt: r.changedAt,
  }));
}
