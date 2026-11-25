/** docs/identity-verification-2026-11: identity checks waiting for an admin (name mismatch, duplicates, unreadable). Admins only. */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { IDENTITY_VERIFICATION_STATUSES, type IdentityVerificationStatus } from "@/server/db/schema";
import { listIdentityReviews } from "@/server/services/identity-verification";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireRole("ADMIN");
  const raw = request.nextUrl.searchParams.get("status");
  const status = (IDENTITY_VERIFICATION_STATUSES as readonly string[]).includes(raw ?? "") ? (raw as IdentityVerificationStatus) : undefined;
  return ok({ items: await listIdentityReviews(user, status) });
});
