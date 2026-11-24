/**
 * Onboarding Phase 2, WP6 "Referral help by PIN" (docs/onboarding-waves-2-3-2026-11;
 * docs/onboarding-benchmark/phase-2/screens-flow-and-implementation-plan.md, F6).
 *
 * An owner on the wizard's first screen with no referral code types the shop's PIN code and is
 * shown the dealers who cover it:
 *
 *   PIN → the most specific area it maps to (geo_area_pincodes, longest prefix)
 *       → that area and its ancestors, closest first (locality → taluka → district → region → state)
 *       → the dealers whose territory (dealer_territories) is one of those areas
 *       → only APPROVED dealers that are not GoKesari's own internal holder
 *       → each dealer's active main code (dealer_codes ACTIVE, not an employee's); none → not listed.
 *
 * Closest area first; a dealer covering two of the areas is listed once, at the closer one. At most
 * MAX_DEALERS. The dealer's phone is returned only when the caller is signed in (the route decides).
 * Read-only: nothing is written. Behind flag onboarding_referral_by_pin_enabled (the route).
 */
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/server/db";
import { dealerTerritories, dealers, type GeoArea } from "@/server/db/schema";
import { areaForPincode, geoAncestry } from "@/server/services/geo-areas";
import { activeCodeFor } from "./codes";

export const MAX_DEALERS = 5;
export const PIN_PATTERN = /^[1-9][0-9]{5}$/;

export interface DealerNearPin {
  /** The dealer's business name. */
  displayName: string;
  /** The area through which the dealer covers the PIN (e.g. "Kothrud", "Pune"). */
  area: string;
  areaLevel: GeoArea["level"];
  /** The dealer's active referral code. */
  code: string;
  /** Only for a signed-in caller; null otherwise or when the dealer has no mobile on file. */
  phone: string | null;
}

export interface DealersForPincodeResult {
  pincode: string;
  /** The area the PIN maps to; null when GoKesari has not mapped the PIN yet. */
  area: string | null;
  dealers: DealerNearPin[];
}

export interface CandidateDealer {
  dealerId: string;
  areaCode: string;
  legalName: string;
  mobileE164: string | null;
  status: string;
  isInternal: boolean;
}

/** The data the resolution reads; injected so the order of resolution is testable without a database. */
export interface DealersForPincodeDeps {
  areaForPincode: (pin: string) => Promise<{ area: GeoArea } | null>;
  ancestry: (areaCode: string) => Promise<GeoArea[]>;
  dealersInAreas: (areaCodes: string[]) => Promise<CandidateDealer[]>;
  activeCode: (dealerId: string) => Promise<string | null>;
}

const liveDeps: DealersForPincodeDeps = {
  areaForPincode: (pin) => areaForPincode(pin),
  ancestry: (code) => geoAncestry(code),
  dealersInAreas: async (codes) =>
    codes.length === 0
      ? []
      : db
          .select({
            dealerId: dealers.id,
            areaCode: dealerTerritories.areaCode,
            legalName: dealers.legalName,
            mobileE164: dealers.mobileE164,
            status: dealers.status,
            isInternal: dealers.isInternal,
          })
          .from(dealerTerritories)
          .innerJoin(dealers, eq(dealers.id, dealerTerritories.dealerId))
          .where(and(inArray(dealerTerritories.areaCode, codes), eq(dealers.status, "APPROVED"))),
  activeCode: (dealerId) => activeCodeFor(dealerId, null),
};

/** "+919876543210" → "+91 98765 43210". */
function showPhone(e164: string | null): string | null {
  if (!e164) return null;
  const m = /^\+91([6-9]\d{4})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

export async function dealersForPincode(
  pincode: string,
  options: { includePhone: boolean; limit?: number },
  deps: DealersForPincodeDeps = liveDeps,
): Promise<DealersForPincodeResult> {
  const pin = pincode.trim();
  const limit = Math.min(Math.max(options.limit ?? MAX_DEALERS, 1), 20);
  if (!PIN_PATTERN.test(pin)) return { pincode: pin, area: null, dealers: [] };
  const place = await deps.areaForPincode(pin);
  if (!place) return { pincode: pin, area: null, dealers: [] };

  // The area, then its parents up to the state — closest first. Inactive areas are skipped.
  const chain = (await deps.ancestry(place.area.code)).filter((a) => a.status === "ACTIVE");
  if (chain.length === 0 || chain[0].code !== place.area.code) chain.unshift(place.area);
  const rank = new Map(chain.map((a, i) => [a.code, i] as const));

  const candidates = (await deps.dealersInAreas(chain.map((a) => a.code))).filter((d) => d.status === "APPROVED" && !d.isInternal && rank.has(d.areaCode));
  // Closest area first, then by name so the order is stable; one row per dealer, at its closest area.
  candidates.sort((a, b) => rank.get(a.areaCode)! - rank.get(b.areaCode)! || a.legalName.localeCompare(b.legalName) || a.dealerId.localeCompare(b.dealerId));
  const seen = new Set<string>();
  const found: DealerNearPin[] = [];
  for (const c of candidates) {
    if (found.length >= limit) break;
    if (seen.has(c.dealerId)) continue;
    seen.add(c.dealerId);
    const code = await deps.activeCode(c.dealerId);
    if (!code) continue;
    const area = chain[rank.get(c.areaCode)!];
    found.push({ displayName: c.legalName, area: area.name, areaLevel: area.level, code, phone: options.includePhone ? showPhone(c.mobileE164) : null });
  }
  return { pincode: pin, area: place.area.name, dealers: found };
}
