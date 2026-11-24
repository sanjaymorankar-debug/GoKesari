/**
 * docs/account-deletion-2026-11 — the signed-in person deletes their own account.
 * GET  → the checks (blockers, subscriptions to cancel) and the latest request's status.
 * POST { code, confirmText: "DELETE", reasonCode, reason? } → hides the account for the cooling-off
 *   period (0191: rule accountDeletion.coolingOffDays, 90) and schedules the anonymisation.
 *   A reason is required: a code from ACCOUNT_DELETION_REASONS, with words for OTHER.
 * Flag account_self_deletion_enabled off → 404.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { deleteAccount, getDeletionStatus } from "@/server/services/account-deletion";

export const dynamic = "force-dynamic";

const schema = z.object({
  code: z.string().trim().min(1).max(12),
  confirmText: z.string().trim().max(20),
  reasonCode: z.string().trim().max(40).nullish(),
  reason: z.string().trim().max(500).nullish(),
});

function ipOf(request: NextRequest): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

export const GET = route(async () => {
  const user = await requireUser();
  return ok(await getDeletionStatus(user.id));
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`account-delete:${user.id}`, { limit: 10, windowMs: 10 * 60_000 });
  const body = await parseBody(request, schema);
  return ok(
    await deleteAccount(
      { id: user.id, role: user.role },
      { code: body.code, confirmText: body.confirmText, reasonCode: body.reasonCode ?? null, reason: body.reason ?? null },
      { ip: ipOf(request), userAgent: request.headers.get("user-agent") },
    ),
  );
});
