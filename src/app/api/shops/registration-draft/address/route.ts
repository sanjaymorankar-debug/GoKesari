/**
 * Owner brief 08-Nov-2026: POST the shop's address — pre-filled from the GST (or PAN) record and
 * confirmed or corrected by the owner, who then marks the shop on the map. Saved on the draft.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { optionalText, requiredText } from "@/lib/shop-settings";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { saveDraftAddress } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const nullable = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);

const schema = z.object({
  addressLine1: requiredText(3, 200),
  addressLine2: nullable(optionalText(200)),
  area: nullable(optionalText(120)),
  city: requiredText(2, 120),
  state: nullable(optionalText(120)),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "PIN code must be 6 digits and not start with 0."),
  landmark: nullable(optionalText(200)),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  // Only while the wizard flag is on (an admin may use it while it is off): the screen is not the only gate.
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await saveDraftAddress({ actor: user, address: { ...body, addressLine2: body.addressLine2 || null, area: body.area || null, state: body.state || null, landmark: body.landmark || null } }));
});
