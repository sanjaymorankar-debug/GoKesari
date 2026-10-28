/** GET ?status=OPEN|UPHELD|REJECTED — attribution claims for staff (admin and operator). docs/dealer-programme. */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { listDisputes } from "@/server/dealers/disputes";
import { requireDealerProgramme } from "@/server/dealers/http";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  await requireRole("ADMIN", "OPERATOR");
  const status = request.nextUrl.searchParams.get("status");
  return ok({ disputes: await listDisputes(status === "OPEN" || status === "UPHELD" || status === "REJECTED" ? { status } : {}) });
});
