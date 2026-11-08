/**
 * Owner brief 08-Nov-2026: POST { ownerName } — asked only when the GST (or PAN) record named no
 * owner, such as a company's GSTIN. Saved on the draft; nothing created yet.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireWizardAvailable, saveDraftOwner } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const schema = z.object({
  ownerName: z.string().trim().min(2, "Enter the owner's name.").max(120),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  // Only while the wizard flag is on (an admin may use it while it is off): the screen is not the only gate.
  await requireWizardAvailable(user);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await saveDraftOwner({ actor: user, ownerName: body.ownerName }));
});
