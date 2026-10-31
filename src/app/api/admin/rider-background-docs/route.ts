/** Gig worker flow (feature 3): admin review list of police verification forms and character certificates. */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { listBackgroundDocsForAdmin, type BackgroundDocStatus } from "@/server/services/rider-background-docs";

export const dynamic = "force-dynamic";

const STATUSES: readonly string[] = ["UPLOADED", "UNDER_REVIEW", "APPROVED", "REJECTED"];

export const GET = route(async (request: NextRequest) => {
  const user = await requireRole("ADMIN");
  const status = new URL(request.url).searchParams.get("status");
  return ok({ documents: await listBackgroundDocsForAdmin(user, status && STATUSES.includes(status) ? (status as BackgroundDocStatus) : undefined) });
});
