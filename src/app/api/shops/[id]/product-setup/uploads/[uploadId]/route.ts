/** Progress and preview of one upload. A check or import that stopped (server restart) is picked up again from here. */
import { after, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { applyUpload, checkUpload, claimStalledUpload, getUploadView } from "@/server/services/shop-bulk-upload";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string; uploadId: string }>) => {
  const user = await requireUser();
  const params = await context.params;
  const id = z.string().uuid().parse(params.id);
  const uploadId = z.string().uuid().parse(params.uploadId);
  const stalled = await claimStalledUpload(id, uploadId, user);
  if (stalled) after(() => (stalled === "CHECKING" ? checkUpload(uploadId) : applyUpload(uploadId, user)));
  return ok(await getUploadView(id, uploadId, user));
});
