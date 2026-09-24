/**
 * Reads and builds the customer's delivery location (GS-004). See
 * lib/location.ts for the cookie shape and services/serviceability.ts for
 * how it filters discovery.
 */
import { cookies } from "next/headers";

import { parseCoordinates } from "@/lib/geo/haversine";
import {
  LOCATION_COOKIE,
  parseLocation,
  roundCoordinate,
  type CustomerLocation,
} from "@/lib/location";
import { listAddresses } from "@/server/services/addresses";
import type { Address } from "@/server/db/schema";

export function locationFromAddress(address: Address): CustomerLocation {
  const coords = parseCoordinates(address.latitude, address.longitude);
  const place = [address.area, address.city].filter(Boolean).join(", ");
  return {
    label: `${address.label ? `${address.label} — ` : ""}${place || address.line1}, ${address.pincode}`.slice(0, 120),
    pincode: address.pincode,
    latitude: coords ? roundCoordinate(coords.latitude) : null,
    longitude: coords ? roundCoordinate(coords.longitude) : null,
    source: "ADDRESS",
    addressId: address.id,
  };
}

/**
 * The location discovery should use for this request: the one the visitor
 * chose (cookie), else — for a signed-in customer — their default saved
 * address, else none (discovery then shows every shop, unfiltered).
 */
export async function getCustomerLocation(userId?: string | null): Promise<CustomerLocation | null> {
  const chosen = parseLocation((await cookies()).get(LOCATION_COOKIE)?.value);
  if (chosen) return chosen;
  if (!userId) return null;
  const [preferred] = await listAddresses(userId); // default first, then newest
  return preferred ? locationFromAddress(preferred) : null;
}
