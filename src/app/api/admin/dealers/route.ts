/**
 * GET ?status=PENDING|APPROVED|…|ALL&q= — the dealer list / approval queue. Admin and operator
 * (read only). docs/dealer-programme, GKS-DR-002.
 */
import type { NextRequest } from "next/server";

import { DEALER_STATUSES, type DealerStatus } from "@/lib/dealers";
import { ok, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { listDealers } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  await requireRole("ADMIN", "OPERATOR");
  const status = request.nextUrl.searchParams.get("status") ?? "ALL";
  const q = request.nextUrl.searchParams.get("q")?.slice(0, 80) ?? undefined;
  return ok({
    dealers: await listDealers({ status: (DEALER_STATUSES as readonly string[]).includes(status) ? (status as DealerStatus) : "ALL", q }),
  });
});
