/**
 * RBAC v2 Phase 3 bank reconciliation, one statement line.
 * GET ?q= — records it could be matched to (same amount within 10 days, or a search by reference / name).
 * POST { action: "match", kind, id, note? } | { action: "accept" } (its suggestion) | { action: "exclude", reason }
 *      | { action: "unmatch" } — Accountant, while the statement is open.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requireAnyPermission, requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { BANK_MATCH_KINDS } from "@/server/db/schema";
import { acceptSuggestion, candidatesForLine, excludeLine, matchLine, unmatchLine } from "@/server/rbac-accounting/bank-reconciliation";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("match"), kind: z.enum(BANK_MATCH_KINDS), id: z.string().uuid(), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("exclude"), reason: z.string().max(500) }),
  z.object({ action: z.literal("unmatch") }),
]);

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireAnyPermission([PERMISSIONS.BANK_RECON_PREPARE, PERMISSIONS.BANK_RECON_SIGNOFF]);
  const id = idSchema.parse((await context.params).id);
  const q = parseQuery(request, z.object({ q: z.string().max(60).optional() }));
  return ok(await candidatesForLine(id, { search: q.q }, actor));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.BANK_RECON_PREPARE);
  const id = idSchema.parse((await context.params).id);
  const body = await parseBody(request, actionSchema);
  switch (body.action) {
    case "match":
      return ok(await matchLine(id, { kind: body.kind, id: body.id, note: body.note }, actor));
    case "accept":
      return ok(await acceptSuggestion(id, actor));
    case "exclude":
      return ok(await excludeLine(id, body.reason, actor));
    default:
      return ok(await unmatchLine(id, actor));
  }
});
