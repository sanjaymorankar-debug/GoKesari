/**
 * Registration duplicate pre-check. The shop registration form calls this
 * when the owner leaves the Shop Act / PAN / Udyam / PIN code field, so a
 * repeat registration is flagged before the whole form is filled in.
 * Advisory only: registerShop() runs the same check again, under a lock, on
 * submit.
 *
 * Says nothing about the matched shop beyond its review status, and echoes
 * identifiers masked. POST rather than GET so a PAN never lands in a URL or
 * an access log; rate-limited because it answers "is this number
 * registered?".
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { checkRegistrationDuplicate } from "@/server/services/shop-duplicates";

const schema = z.object({
  shopActNumber: z.string().max(60).nullish(),
  panNumber: z.string().max(20).nullish(),
  udyamNumber: z.string().max(40).nullish(),
  name: z.string().max(120).nullish(),
  addressLine1: z.string().max(200).nullish(),
  pincode: z.string().max(6).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  enforceRateLimit(`shop-identity-check:${user.id}`, RATE_LIMITS.SHOP_IDENTITY_CHECK);
  const body = await parseBody(request, schema);
  return ok(await checkRegistrationDuplicate(body, { id: user.id }));
});
