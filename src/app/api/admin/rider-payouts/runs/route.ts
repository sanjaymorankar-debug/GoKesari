/**
 * Monthly rider payout runs (docs/gig-bank-payouts-2026-10).
 *   GET  → runs, newest month first, and the transfers waiting for review (FINANCE_VIEW)
 *   POST { month: "YYYY-MM" } → start or resume that month's run now (ADMIN; same once-only guard)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listRuns, runMonthNow } from "@/server/rider-wallet/monthly";
import { listRecentWithdrawals, listTransfersForReview } from "@/server/rider-wallet/views";

export const dynamic = "force-dynamic";

const schema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.FINANCE_VIEW);
  return ok({ runs: await listRuns(), review: await listTransfersForReview(), withdrawals: await listRecentWithdrawals(50) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_PREPARE);
  if (user.role !== "ADMIN") throw forbidden("Only an admin can start a payout run.");
  const body = await parseBody(request, schema);
  return ok(await runMonthNow(body.month, user));
});
