import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { cancelUpload } from "@/server/services/shop-bulk-upload";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string; uploadId: string }>) => {
  const user = await requireUser();
  const params = await context.params;
  return ok(await cancelUpload(z.string().uuid().parse(params.id), z.string().uuid().parse(params.uploadId), user));
});
