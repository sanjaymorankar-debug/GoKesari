/**
 * POST — ADMIN only: ask the bank again whether the dealer's account is valid and in the holder's
 * name (Cashfree Bank Account Verification). docs/dealer-programme, GKS-DR-002.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { checkDealerBank, dealerView } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const dealer = await checkDealerBank(z.string().uuid().parse((await context.params).id), admin);
  return ok({ dealer: await dealerView(dealer) });
});
