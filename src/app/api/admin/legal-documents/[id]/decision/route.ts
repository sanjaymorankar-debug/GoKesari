/** Operations approve a submitted legal document, or reject it with a reason the shop sees. SHOP_GST_PAN_VERIFY. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { decideLegalDocument } from "@/server/services/legal-documents";

const schema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(500).nullish() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.SHOP_GST_PAN_VERIFY);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await decideLegalDocument(id, body, user));
});
