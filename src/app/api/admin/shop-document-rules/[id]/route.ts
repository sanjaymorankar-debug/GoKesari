/**
 * DF-09: DELETE — removes one shop document rule (ADMIN only, audited). The document then follows a
 * broader rule (all shops / food shops), or is no longer asked of that scope.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { getDocumentRulesAdmin, removeDocumentRule } from "@/server/services/shop-document-rules";

export const dynamic = "force-dynamic";

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const admin = await requireRole("ADMIN");
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) throw validationFailed("Unknown rule.");
  await removeDocumentRule(id, admin);
  return ok(await getDocumentRulesAdmin());
});
