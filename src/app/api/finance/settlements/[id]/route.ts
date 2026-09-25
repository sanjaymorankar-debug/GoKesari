/**
 * Shop settlement lifecycle (Part D/F), FINANCE_MANAGE (admin):
 * approve (PENDING→ELIGIBLE) · process (sent to bank) · pay (reference) ·
 * fail (bank rejected; re-process to retry) · reverse (PAID returned) · cancel.
 * Records what happened at the bank — nothing is transferred from here.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { decideShopSettlement } from "@/server/services/finance";

const schema = z.object({
  action: z.enum(["approve", "process", "pay", "fail", "reverse", "cancel"]),
  /** Bank/UTR reference for "pay"; the bank's reason for "fail" / "reverse". */
  note: z.string().max(200).optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_MANAGE);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await decideShopSettlement(id, body.action, user, body.note));
});
