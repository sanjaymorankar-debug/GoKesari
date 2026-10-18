/**
 * F9.2.6 place of supply and supplier-registration wording (batch-2026-10
 * WS-E) — pure functions, shared by the invoice snapshot (services/invoices.ts)
 * and the invoice delivery module.
 */
import { gstState } from "@/lib/gst-states";
import { stateForPincode } from "@/lib/pincode-state";

/* ------------------------------------------------------- place of supply */

export type PlaceOfSupplySource = "ADDRESS_STATE" | "ADDRESS_PIN" | "PICKUP_SHOP" | "ASSUMED_SELLER_STATE" | "UNKNOWN";

/**
 * Goods: the place of supply is where delivery ends (s.10(1)(a) IGST Act) —
 * the delivery address; over the counter (pickup), the shop (s.10(1)(d)).
 */
export function resolvePlaceOfSupply(input: {
  sellerState: string | null;
  hasDeliveryAddress: boolean;
  addressState: string | null | undefined;
  addressPincode: string | null | undefined;
  usePincode: boolean;
}): { state: string | null; source: PlaceOfSupplySource } {
  if (!input.hasDeliveryAddress) return { state: input.sellerState, source: input.sellerState ? "PICKUP_SHOP" : "UNKNOWN" };
  const named = gstState(input.addressState ?? null)?.alpha ?? null;
  if (named) return { state: named, source: "ADDRESS_STATE" };
  const byPin = input.usePincode ? stateForPincode(input.addressPincode) : null;
  if (byPin) return { state: byPin, source: "ADDRESS_PIN" };
  return input.sellerState ? { state: input.sellerState, source: "ASSUMED_SELLER_STATE" } : { state: null, source: "UNKNOWN" };
}

export const PLACE_OF_SUPPLY_NOTE: Partial<Record<PlaceOfSupplySource, string>> = {
  ASSUMED_SELLER_STATE:
    "Place of supply: the delivery address has no state on record, so the supplier's state was taken (intra-state supply).",
  UNKNOWN: "Place of supply could not be determined from the records; treated as an intra-state supply.",
};

/* -------------------------------------------- supplier registration notes */

export type SellerRegistration = "REGISTERED" | "COMPOSITION" | "UNREGISTERED";

export function sellerRegistrationOf(gstin: string | null, gstStatus: string | null | undefined): SellerRegistration {
  if (gstin) return "REGISTERED";
  return gstStatus === "COMPOSITION" ? "COMPOSITION" : "UNREGISTERED";
}

/** Wording printed on a bill of supply for a supplier without a GSTIN on the invoice. */
export function sellerRegistrationNotes(registration: SellerRegistration, panMasked: string | null): string[] {
  if (registration === "COMPOSITION") {
    return ["Composition taxable person, not eligible to collect tax on supplies. Bill of supply: no GST is charged."];
  }
  if (registration === "UNREGISTERED") {
    return [
      panMasked
        ? `Supplier not registered under GST (PAN-only seller, PAN ${panMasked}). Bill of supply: no GST is charged.`
        : "Supplier not registered under GST. Bill of supply: no GST is charged.",
    ];
  }
  return [];
}
