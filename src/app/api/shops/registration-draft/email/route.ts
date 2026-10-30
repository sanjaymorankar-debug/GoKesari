/**
 * Shop registration (0120), the shop's email:
 *   POST { useAccount: true }       → the account's own email (proven by the sign-in)
 *   POST { email }                  → another address: a code is emailed to it
 *   POST { email, code }            → the code confirms it
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  confirmDraftEmailCode,
  requestDraftEmailCode,
  requireWizardAvailable,
  useAccountEmailForShop,
} from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const schema = z.union([
  z.object({ useAccount: z.literal(true) }),
  z.object({ email: z.string().trim().min(3).max(254), code: z.string().trim().min(4).max(8) }),
  z.object({ email: z.string().trim().min(3).max(254) }),
]);

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  // Only while the wizard flag is on (an admin may use it while it is off): the screen is not the only gate.
  await requireWizardAvailable(user);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  if ("useAccount" in body) return ok(await useAccountEmailForShop({ actor: user }));
  if ("code" in body) return ok(await confirmDraftEmailCode({ actor: user, email: body.email, code: body.code, ip }));
  return ok({ codeSent: await requestDraftEmailCode({ actor: user, email: body.email, ip }) });
});
