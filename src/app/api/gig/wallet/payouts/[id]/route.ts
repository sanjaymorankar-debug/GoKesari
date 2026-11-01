/** One payment's statement for the rider who received it (docs/gig-bank-payouts-2026-10). */
import type { NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { isUuid } from "@/server/payouts/http";
import { getTransferStatement } from "@/server/rider-wallet/views";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  if (!isUuid(id)) throw notFound("Payment");
  return ok(await getTransferStatement(id, user.id));
});
