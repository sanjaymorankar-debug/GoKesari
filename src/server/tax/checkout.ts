/**
 * Billing v2 at checkout (docs/billing §3.3, §4.4), only while billing_v2 is on:
 *
 *   - supplies a shop may not make are refused before payment: a GSTIN that
 *     is cancelled or suspended on the portal, and an Enrolment-ID or
 *     composition shop delivering to another state (tax engine supplyBlock);
 *   - a customer's own GSTIN makes the shop's invoice B2B: format and check
 *     digit always, then the GST check (GSP) — an inactive GSTIN is refused,
 *     an unavailable check keeps it as UNVERIFIED.
 */
import { gstState, isValidGstin } from "@/lib/gst-states";
import { validationFailed } from "@/lib/errors";
import { stateForPincode } from "@/lib/pincode-state";
import { checkGstin, normaliseGstin } from "@/server/gst/gstin";
import { getRule } from "@/server/services/settings";
import { istDay, statutoryResolver, unregisteredRulesOn } from "@/server/statutory/rates";
import { effectiveRegistrationType, supplyBlock, type GstRegistrationType, type GstPortalStatus } from "./engine";

/** Two-letter state of a shop's GST registration: the recorded state, its GSTIN's, else its address's. */
export function supplierStateOf(shop: { gstStateCode?: string | null; gstin?: string | null; state?: string | null }): string | null {
  return gstState(shop.gstStateCode ?? null)?.alpha ?? gstState(shop.gstin ?? null)?.alpha ?? gstState(shop.state ?? null)?.alpha ?? null;
}

/** Two-letter place of supply of a delivery address: its state, else its PIN code's. */
export function placeOfSupplyOf(address: { state?: string | null; pincode?: string | null } | null): string | null {
  if (!address) return null;
  return gstState(address.state ?? null)?.alpha ?? stateForPincode(address.pincode ?? null) ?? null;
}

export interface GuardShop {
  name: string;
  gstRegistrationType: GstRegistrationType;
  gstStatus: string | null;
  gstin: string | null;
  gstStateCode: string | null;
  gstPortalStatus: GstPortalStatus | null;
  state: string | null;
}

/** Throws the customer-facing reason when a shop in the cart may not make this supply. */
export async function assertSuppliesAllowed(cartShops: GuardShop[], address: { state?: string | null; pincode?: string | null } | null, at = new Date()): Promise<void> {
  const rule = await getRule("billing");
  const unreg = await unregisteredRulesOn(istDay(at), statutoryResolver());
  const guard = { enrolmentInterStateAllowed: unreg.interStateAllowed, compositionInterStateAllowed: rule.compositionInterStateAllowed };
  // A pickup is supplied at the shop: always intra-state.
  const pos = address ? placeOfSupplyOf(address) : null;
  for (const shop of cartShops) {
    const block = supplyBlock(
      { registrationType: effectiveRegistrationType(shop), stateCode: supplierStateOf(shop), portalStatus: shop.gstPortalStatus },
      pos,
      guard,
    );
    if (block) throw validationFailed(`${shop.name}: ${block.message}`, { reason: block.code });
  }
}

export interface BuyerGstin {
  gstin: string;
  legalName: string | null;
  status: "VERIFIED" | "UNVERIFIED";
}

/** The customer's GSTIN for a B2B invoice, checked. */
export async function resolveBuyerGstin(raw: string, actor: { id: string }): Promise<BuyerGstin> {
  const gstin = normaliseGstin(raw);
  if (!isValidGstin(gstin)) {
    throw validationFailed("This is not a valid GSTIN: it must be 15 characters and its last character must match (check digit).", { fields: { buyerGstin: "Check the GSTIN." } });
  }
  const check = await checkGstin(gstin, actor);
  if (!check.ok) return { gstin, legalName: null, status: "UNVERIFIED" };
  if (!check.found || !check.active) {
    throw validationFailed(check.message, { fields: { buyerGstin: check.message } });
  }
  return { gstin, legalName: check.legalName ?? check.tradeName, status: "VERIFIED" };
}
