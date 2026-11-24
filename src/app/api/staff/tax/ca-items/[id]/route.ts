/**
 * docs/tax-register: one CA item.
 * PATCH { area?, title?, question?, blocks?, priority?, dueOn?, answer? } → edit (Accountant, admin)
 * POST  { action: SUBMIT | APPROVE | SEND_BACK | CLOSE | REOPEN | NOTE, text? }
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { actOnCaItem, addCaItemNote, caItemPatch, updateCaItem } from "@/server/tax-register/ca-items";

export const dynamic = "force-dynamic";

const actionSchema = z.object({ action: z.enum(["SUBMIT", "APPROVE", "SEND_BACK", "CLOSE", "REOPEN", "NOTE"]), text: z.string().max(5000).nullish() });

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireAnyPermission([PERMISSIONS.TAX_PARAM_PROPOSE]);
  const { id } = await context.params;
  return ok(await updateCaItem(id, await parseBody(request, caItemPatch), actor));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireAnyPermission([PERMISSIONS.TAX_PARAM_PROPOSE, PERMISSIONS.TAX_PARAM_APPROVE]);
  const { id } = await context.params;
  const body = await parseBody(request, actionSchema);
  if (body.action === "NOTE") {
    await addCaItemNote(id, body.text ?? "", actor);
    return ok({ done: true });
  }
  return ok(await actOnCaItem(id, body.action, actor, body.text));
});
