/** GET — one uploaded document file of an own shop, for viewing online (audited) (F8.4.2). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getShopDocumentFile } from "@/server/services/operator-limited";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ fileId: string }>) => {
  const user = await requirePermission(PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS);
  const fileId = z.string().uuid().parse((await context.params).fileId);
  const file = await getShopDocumentFile(fileId, user);
  return new Response(new Uint8Array(file.data), {
    headers: { "Content-Type": file.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  }) as never;
});
