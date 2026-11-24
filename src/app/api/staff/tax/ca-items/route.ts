/**
 * docs/tax-register: questions for the CA.
 * GET  → items with their notes, and the switches each holds back (Accountant, CA, admin)
 * POST → add an item (Accountant, admin)
 */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { caItemInput, createCaItem, listCaItems } from "@/server/tax-register/ca-items";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const actor = await requireAnyPermission([PERMISSIONS.TAX_PARAM_PROPOSE, PERMISSIONS.TAX_PARAM_APPROVE]);
  return ok(await listCaItems(actor));
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireAnyPermission([PERMISSIONS.TAX_PARAM_PROPOSE]);
  return ok(await createCaItem(await parseBody(request, caItemInput), actor), 201);
});
