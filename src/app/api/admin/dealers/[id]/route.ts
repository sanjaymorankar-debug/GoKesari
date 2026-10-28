/**
 * GET — one dealer for staff: profile, documents, codes, employees (PAN, bank account and mobile
 * masked). Admin and operator. docs/dealer-programme, GKS-DR-002.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { dealerAccountEmail, dealerView, getDealer, listSalespeople } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDealerProgramme();
  await requireRole("ADMIN", "OPERATOR");
  const dealer = await getDealer(z.string().uuid().parse((await context.params).id));
  return ok({ dealer: await dealerView(dealer), accountEmail: await dealerAccountEmail(dealer), salespeople: await listSalespeople(dealer.id) });
});
