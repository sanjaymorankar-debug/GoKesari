/** One monthly rider payout run with its transfers (FINANCE_VIEW; docs/gig-bank-payouts-2026-10). */
import type { NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { isUuid } from "@/server/payouts/http";
import { getRun } from "@/server/rider-wallet/monthly";
import { runTransferViews } from "@/server/rider-wallet/views";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requirePermission(PERMISSIONS.FINANCE_VIEW);
  const { id } = await context.params;
  if (!isUuid(id)) throw notFound("Payout run");
  const { run, transfers } = await getRun(id);
  return ok({ run, transfers: await runTransferViews(transfers) });
});
