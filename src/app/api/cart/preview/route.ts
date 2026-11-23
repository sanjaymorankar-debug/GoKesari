/**
 * docs/guest-cart-2026-11: prices a guest's browser cart (no sign-in). Reads
 * only — nothing is saved. 404 while the guest_cart_enabled flag is off.
 * Abuse: at most 50 lines a call (the guest-cart limit) and the per-IP API
 * limit in src/proxy.ts.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { GUEST_CART_MAX_LINES } from "@/lib/guest-cart";
import { MAX_CART_LINE_QUANTITY } from "@/lib/stock-quantity";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireFeature } from "@/server/services/feature-flags";
import { previewGuestCart } from "@/server/services/guest-cart";

export const dynamic = "force-dynamic";

const guestLinesSchema = z.object({
  lines: z
    .array(z.object({ shopProductId: z.string().uuid(), quantity: z.number().positive().max(MAX_CART_LINE_QUANTITY) }))
    .max(GUEST_CART_MAX_LINES),
});

export const POST = route(async (request: NextRequest) => {
  await requireFeature("guest_cart_enabled");
  const { lines } = await parseBody(request, guestLinesSchema);
  return ok(await previewGuestCart(lines));
});
