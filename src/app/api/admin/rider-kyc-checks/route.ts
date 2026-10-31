/** Gig worker flow (feature 2): admin list of partner PAN / Aadhaar checks (masked numbers only). */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { listRiderKycChecksForAdmin } from "@/server/services/rider-kyc";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireRole("ADMIN");
  const status = new URL(request.url).searchParams.get("status");
  const filter = status === "PENDING" || status === "VERIFIED" || status === "FAILED" ? status : undefined;
  return ok({ checks: await listRiderKycChecksForAdmin(user, filter) });
});
