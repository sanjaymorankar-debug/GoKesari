/**
 * Close the last complete payout cycle now (PAYOUT_MANAGE) — what the
 * payout-cycle job does on its schedule. The admin who closes it becomes the
 * batch's maker, so (maker-checker) someone else approves it.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { closePayoutCycle } from "@/server/payouts/cycle";

const schema = z.object({ today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PAYOUT_MANAGE);
  const body = await parseBody(request, schema);
  const result = await closePayoutCycle({ today: body.today, actor: user });
  return ok(result ? { cycle: result.cycle, batch: result.batch, items: result.items.length, created: result.created } : { cycle: null }, result?.created ? 201 : 200);
});
