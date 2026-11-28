/**
 * Support escalations (0232; owner, 28-Nov-2026): held v2 / v3 shops, pay-later requests, shops not selling.
 *
 * GET  ?level=FRANCHISEE|OPERATOR|ADMIN|ALL&open=0|1   → { rows, counts, flags }
 * POST { escalationId, action: "APPROVE" | "REJECT" | "CLOSE", note? }
 *      SHOP_REVIEW: approve (live) / reject (note required, shown to the owner); FEE_PAY_LATER: the pay-later decision
 *      once the request has left the franchisee; NO_PRODUCTS_OR_SALES: close with a note.
 * POST { flagId, action: "CLEAR_FLAG", note }   → a review flag (weak name match, PAN not inside the GSTIN) checked.
 * Admin and operator (SHOP_APPROVE); every step is audited.
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { SUPPORT_ESCALATION_LEVELS, supportEscalations } from "@/server/db/schema";
import {
  closeEscalation,
  countOpenEscalations,
  decideEscalatedPayLater,
  decideHeldShop,
  listEscalations,
  listOpenReviewFlags,
  resolveReviewFlag,
} from "@/server/services/support-escalations";

export const dynamic = "force-dynamic";

const query = z.object({ level: z.enum([...SUPPORT_ESCALATION_LEVELS, "ALL"]).optional(), open: z.enum(["0", "1"]).optional() });

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.SHOP_APPROVE);
  const params = query.parse(Object.fromEntries(new URL(request.url).searchParams));
  const [rows, counts, flags] = await Promise.all([listEscalations({ level: params.level ?? "ALL", open: params.open !== "0" }), countOpenEscalations(), listOpenReviewFlags()]);
  return ok({ rows, counts, flags });
});

const body = z.union([
  z.object({ escalationId: z.string().uuid(), action: z.enum(["APPROVE", "REJECT", "CLOSE"]), note: z.string().trim().max(500).nullish() }),
  z.object({ flagId: z.string().uuid(), action: z.literal("CLEAR_FLAG"), note: z.string().trim().max(500).nullish() }),
]);

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_APPROVE);
  const input = await parseBody(request, body);
  const actor = { id: user.id, role: user.role };
  if ("flagId" in input) {
    await resolveReviewFlag(input.flagId, input.note ?? null, actor);
    return ok({ cleared: true });
  }
  if (input.action === "CLOSE") return ok({ escalation: await closeEscalation(input.escalationId, input.note ?? null, actor) });
  const [row] = await db.select({ kind: supportEscalations.kind }).from(supportEscalations).where(eq(supportEscalations.id, input.escalationId));
  if (!row) throw notFound("Escalation");
  if (row.kind === "FEE_PAY_LATER") return ok(await decideEscalatedPayLater(input.escalationId, input.action, input.note ?? null, actor));
  return ok(await decideHeldShop(input.escalationId, input.action, input.note ?? null, actor));
});
