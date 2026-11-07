/**
 * Finance: how Cashfree is set up on this site (docs/payments-cashfree-audit-2026-11).
 *   GET  /api/admin/payments/cashfree          — environment, base URLs, key kind (never values), URLs, problems
 *   GET  /api/admin/payments/cashfree?live=1   — plus Cashfree's own answer: keys accepted, eligible payment methods
 * Also lists the last ₹1 payment tests. FINANCE_VIEW.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { cashfreeHealth, listCashfreeLiveTests } from "@/server/payments/cashfree-health";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_VIEW);
  const live = request.nextUrl.searchParams.get("live") === "1";
  if (live) enforceRateLimit(`cashfree-health:${user.id}`, RATE_LIMITS.PAYMENT);
  const [health, tests] = await Promise.all([cashfreeHealth(user, { live }), listCashfreeLiveTests(user)]);
  return ok({ health, tests });
});
