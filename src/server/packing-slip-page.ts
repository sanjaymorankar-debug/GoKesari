import { cache } from "react";

import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { getPackingSlip } from "@/server/services/packing-slip";

/**
 * The signed-in user's packing slip for an order, or null when there is none for them (no such
 * order, not their shop's, or not a valid id). Cached for one server render: the Seller Central
 * layout asks first, so a missing slip answers 404 before the page streams (D-109), and the page
 * reuses the same read.
 */
export const findPackingSlip = cache(async (orderId: string) => {
  const user = await getCurrentUser();
  if (!user || !/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  return getPackingSlip(orderId, user).catch((error) => {
    if (error instanceof AppError && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")) return null;
    throw error;
  });
});
