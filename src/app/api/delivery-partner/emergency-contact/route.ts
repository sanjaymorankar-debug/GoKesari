/**
 * The rider's emergency contact (Rider App v2).
 *   GET   → {name, mobile, relation}
 *   PATCH {name, mobile, relation?} → {name, mobile, relation} (audited)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getMyEmergencyContact, updateMyEmergencyContact } from "@/server/services/rider-sos";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().max(120),
  mobile: z.string().max(15),
  relation: z.string().max(40).nullish(),
});

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  const contact = await getMyEmergencyContact(user.id);
  if (!contact) throw notFound("Delivery partner profile");
  return ok(contact);
});

export const PATCH = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  enforceRateLimit(`rider-emergency-contact:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await updateMyEmergencyContact(user, body));
});
