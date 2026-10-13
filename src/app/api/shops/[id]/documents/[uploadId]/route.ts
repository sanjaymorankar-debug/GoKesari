/** docs/document-upload-2026-10: discard an upload that was not submitted (its file and read fields are erased). */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { discardUpload } from "@/server/services/document-uploads";

export const dynamic = "force-dynamic";

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string; uploadId: string }>) => {
  const { id, uploadId } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  await discardUpload(id, uploadId, user);
  return ok({ discarded: true });
});
