/**
 * The franchisee's support escalations (0232; owner, 28-Nov-2026: "first contact and support from franchisee"):
 * held shops, pay-later requests and shops not selling of the shops registered with their codes.
 *
 * GET                                                     → { rows } (open items assigned to this franchisee)
 * POST { escalationId, action: "APPROVE" | "REJECT", note? } → the held shop / pay-later decision
 * The service checks the item is this franchisee's (else 403).
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { supportEscalations } from "@/server/db/schema";
import { decideEscalatedPayLater, decideHeldShop, listEscalations } from "@/server/services/support-escalations";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok({ rows: await listEscalations({ franchiseeUserId: user.id }) });
});

const body = z.object({ escalationId: z.string().uuid(), action: z.enum(["APPROVE", "REJECT"]), note: z.string().trim().max(500).nullish() });

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`dealer-support-escalations:${user.id}`, RATE_LIMITS.MUTATION);
  const input = await parseBody(request, body);
  const actor = { id: user.id, role: user.role };
  const [row] = await db.select({ kind: supportEscalations.kind, franchiseeUserId: supportEscalations.franchiseeUserId }).from(supportEscalations).where(eq(supportEscalations.id, input.escalationId));
  // Another franchisee's item is not even confirmed to exist.
  if (!row || row.franchiseeUserId !== user.id) throw notFound("Escalation");
  if (row.kind === "FEE_PAY_LATER") return ok(await decideEscalatedPayLater(input.escalationId, input.action, input.note ?? null, actor));
  return ok(await decideHeldShop(input.escalationId, input.action, input.note ?? null, actor));
});
