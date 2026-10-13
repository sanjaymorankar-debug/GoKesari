/** An uploaded document awaiting confirmation — its shop's owner or a reviewer only; never cached. */
import { NextResponse, type NextRequest } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getUploadFile } from "@/server/services/document-uploads";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string; uploadId: string }>) => {
  const { id, uploadId } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  const file = await getUploadFile(uploadId, user);
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
