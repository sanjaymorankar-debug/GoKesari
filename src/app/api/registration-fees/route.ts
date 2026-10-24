/**
 * Registration fee schedule (§12). ADMIN only.
 *
 * Changing the fee here never rewrites an existing shop's snapshot — see
 * services/registration-fees.ts for why that is enforced at the data model
 * rather than trusted to callers.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { MAX_REGISTRATION_FEE_PAISE } from "@/lib/money-limits";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  getActiveFee,
  listFeeHistory,
  listFees,
  setRegistrationFee,
} from "@/server/services/registration-fees";

const schema = z.object({
  // TC-FLD-112: a named ceiling (₹10,00,000), not ₹10 crore.
  amountPaise: z.number().int().min(0).max(MAX_REGISTRATION_FEE_PAISE),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date (YYYY-MM-DD).")
    .optional(),
  reason: z.string().max(500).nullish(),
  note: z.string().max(500).nullish(),
});

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.REGISTRATION_FEE_MANAGE);
  const [active, schedule, history] = await Promise.all([
    getActiveFee(),
    listFees(),
    listFeeHistory(),
  ]);
  return ok({ active: active ?? null, schedule, history });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.REGISTRATION_FEE_MANAGE);
  const body = await parseBody(request, schema);
  return ok(await setRegistrationFee(body, user), 201);
});
