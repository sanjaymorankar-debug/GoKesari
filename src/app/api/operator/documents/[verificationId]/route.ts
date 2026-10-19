/** POST { decision: "approve" | "reject", reason } — decide one document of an own shop (F8.4.2). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { decideShopDocument } from "@/server/services/operator-limited";

export const dynamic = "force-dynamic";

const schema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().max(500).default("") });

export const POST = route(async (request: NextRequest, context: RouteContext<{ verificationId: string }>) => {
  const user = await requirePermission(PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS);
  const id = z.string().uuid().parse((await context.params).verificationId);
  const body = await parseBody(request, schema);
  return ok(await decideShopDocument(id, body, user));
});
