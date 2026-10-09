/** C5: rider identity documents for review — admins only (never operators). */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { listRiderDocumentsForAdmin } from "@/server/services/rider-files";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireRole("ADMIN");
  const status = new URL(request.url).searchParams.get("status");
  const documents = await listRiderDocumentsForAdmin(
    user,
    status === "SUBMITTED" || status === "ACCEPTED" || status === "REJECTED" ? status : undefined,
  );
  return ok({ documents });
});
