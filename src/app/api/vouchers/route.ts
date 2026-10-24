/** Voucher list (admin/operator) and creation (admin only, §37). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isoDateSchema } from "@/server/api/date-schema";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { createVoucher, listVouchers } from "@/server/services/vouchers";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    name: z.string().min(3).max(120),
    code: z.string().max(32).nullish(),
    description: z.string().max(1000).nullish(),
    termsAndConditions: z.string().max(2000).nullish(),
    applyMode: z.enum(["CODE", "AUTO_APPLY"]).optional(),
    bonusPercent: z.number().int().positive().max(100),
    minimumTopupPaise: z.number().int().min(0).optional(),
    maximumBonusPaise: z.number().int().min(0).nullish(),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    usageLimit: z.number().int().positive().nullish(),
    perCustomerLimit: z.number().int().positive().optional(),
    // TC-FLD-114: a budget of 0 could never pay a bonus (leave it out for no budget).
    totalBudgetPaise: z.number().int().min(1, "The total budget must be at least 1 paisa — leave it empty for no budget.").nullish(),
  })
  .transform((v) => ({
    ...v,
    maximumBonusPaise: v.maximumBonusPaise ?? null,
    usageLimit: v.usageLimit ?? null,
    totalBudgetPaise: v.totalBudgetPaise ?? null,
  }));

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.VOUCHER_VIEW);
  const p = new URL(request.url).searchParams;
  const vouchers = await listVouchers({
    search: p.get("q") ?? undefined,
    status: (p.get("status") as never) ?? undefined,
  });
  return ok({ vouchers });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.VOUCHER_MANAGE);
  const body = await parseBody(request, schema);
  return ok(await createVoucher(body, user), 201);
});
