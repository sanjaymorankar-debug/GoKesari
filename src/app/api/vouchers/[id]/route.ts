/** Edit a voucher (admin only, §37). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isoDateSchema } from "@/server/api/date-schema";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { updateVoucher } from "@/server/services/vouchers";

const schema = z.object({
  name: z.string().min(3).max(120).optional(),
  code: z.string().max(32).nullish(),
  description: z.string().max(1000).nullish(),
  termsAndConditions: z.string().max(2000).nullish(),
  applyMode: z.enum(["CODE", "AUTO_APPLY"]).optional(),
  bonusPercent: z.number().int().positive().max(100).optional(),
  minimumTopupPaise: z.number().int().min(0).optional(),
  maximumBonusPaise: z.number().int().min(0).nullish(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  usageLimit: z.number().int().positive().nullish(),
  perCustomerLimit: z.number().int().positive().optional(),
  totalBudgetPaise: z.number().int().min(0).nullish(),
});

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const { id } = await context.params;
    const user = await requirePermission(PERMISSIONS.VOUCHER_MANAGE);
    const body = await parseBody(request, schema);
    return ok(await updateVoucher(id, body, user));
  },
);
