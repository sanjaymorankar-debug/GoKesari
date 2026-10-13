/** docs/document-upload-2026-10: the shop's document checklist — what is needed, what was uploaded, what is done. */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getDocumentChecklist } from "@/server/services/document-uploads";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  return ok(await getDocumentChecklist(id, user));
});
