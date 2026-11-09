/** "Import valid rows and skip errors". Safe to send twice: only the first starts the import. */
import { after, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { applyUpload, confirmUpload } from "@/server/services/shop-bulk-upload";

export const dynamic = "force-dynamic";

const body = z.object({ confirmPause: z.boolean().default(false) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string; uploadId: string }>) => {
  const user = await requireUser();
  const params = await context.params;
  const id = z.string().uuid().parse(params.id);
  const uploadId = z.string().uuid().parse(params.uploadId);
  const { confirmPause } = await parseBody(request, body);
  const { view, started } = await confirmUpload(id, uploadId, { confirmPause }, user);
  if (started) {
    after(async () => {
      try {
        await applyUpload(uploadId, user);
      } catch (error) {
        console.error("[shop-bulk-upload] import failed", uploadId, error);
      }
    });
  }
  return ok(view, 202);
});
