/**
 * The dealer's employees (docs/dealer-programme, GKS-DR-004). Approved dealers only, own
 * employees only.
 *
 * GET → employees with their codes
 * POST { employeeId, name, mobile? } → added, with an employee code (GKS-FE-…)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireDealerProgramme } from "@/server/dealers/http";
import { addSalesperson, listSalespeople, requireApprovedDealer } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  const dealer = await requireApprovedDealer(user);
  return ok({ salespeople: await listSalespeople(dealer.id) });
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  const dealer = await requireApprovedDealer(user);
  const body = await parseBody(request, z.object({ employeeId: z.string().max(60), name: z.string().max(200), mobile: z.string().max(20).nullish() }));
  return ok({ salesperson: await addSalesperson(dealer.id, body, user) });
});
