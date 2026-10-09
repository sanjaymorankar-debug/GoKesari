/** Referral codes (§4.3). Operator/admin only. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  createReferralCode,
  getReferralPerformance,
  listReferralCodes,
} from "@/server/services/referrals";

const schema = z.object({
  code: z.string().min(3).max(32),
  label: z.string().max(120).nullish(),
  referrerName: z.string().max(120).nullish(),
  expiresAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date (YYYY-MM-DD).")
    .nullish(),
  note: z.string().max(500).nullish(),
  // Module 3: self-registration.
  distributorId: z.string().uuid().nullish(),
  maxUses: z.number().int().min(1).max(100_000).nullish(),
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.REFERRAL_MANAGE);
  const params = new URL(request.url).searchParams;

  if (params.get("report") === "1") {
    return ok({ performance: await getReferralPerformance() });
  }
  return ok({
    codes: await listReferralCodes({
      search: params.get("q") ?? undefined,
    }),
  });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.REFERRAL_MANAGE);
  const body = await parseBody(request, schema);
  return ok(await createReferralCode(body, user), 201);
});
