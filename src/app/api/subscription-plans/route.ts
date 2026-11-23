/**
 * Subscription plans near the customer (docs/subscription-plans-2026-11).
 * GET ?kind=&slot=&addressId= — plans of the shops that deliver to the address
 * (a signed-in customer's saved address), else to the chosen location / default
 * address; [] when there is no location to go by.
 */
import type { NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { PLAN_KINDS, PLAN_SLOTS } from "@/lib/subscription-plans";
import { ok, parseQuery, route } from "@/server/api/handler";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { addresses } from "@/server/db/schema";
import { getCustomerLocation, locationFromAddress } from "@/server/location";
import { findPlansNear } from "@/server/services/subscription-plans";
import { validationFailed } from "@/lib/errors";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  kind: z.enum(PLAN_KINDS).optional(),
  slot: z.enum(PLAN_SLOTS).optional(),
  addressId: z.string().uuid().optional(),
});

export const GET = route(async (request: NextRequest) => {
  const query = parseQuery(request, querySchema);
  const user = await getCurrentUser();
  let location = null;
  if (query.addressId) {
    if (!user) throw validationFailed("Sign in to use a saved address.");
    const [address] = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, query.addressId), eq(addresses.userId, user.id), isNull(addresses.deletedAt)))
      .limit(1);
    if (!address) throw validationFailed("Choose one of your saved delivery addresses.");
    location = locationFromAddress(address);
  } else {
    location = await getCustomerLocation(user?.id);
  }
  if (!location) return ok([]);
  return ok(await findPlansNear(location, { kind: query.kind, slot: query.slot }));
});
