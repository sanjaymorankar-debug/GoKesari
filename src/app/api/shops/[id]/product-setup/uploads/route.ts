/**
 * GET → this shop's upload history. POST multipart `file` → 202; the file is
 * checked in the background (poll uploads/{id}) and nothing changes until
 * uploads/{id}/confirm.
 */
import { after, type NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { getImportLimits } from "@/server/services/product-import";
import { assertUploadAccess, checkUpload, createUpload, listUploadHistory } from "@/server/services/shop-bulk-upload";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  return ok({ uploads: await listUploadHistory(id, user) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  await assertUploadAccess(id, user);
  enforceRateLimit(`product-setup-upload:${user.id}`, { limit: 30, windowMs: 60 * 60_000 });
  const { maxFileBytes } = await getImportLimits();
  const tooLarge = `The file is too large. The limit is ${Math.round(maxFileBytes / (1024 * 1024))} MB.`;
  if (Number(request.headers.get("content-length") ?? "0") > maxFileBytes + 1024 * 1024) throw validationFailed(tooLarge);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) throw validationFailed("Choose the Excel or CSV file to upload.");
  if (file.size > maxFileBytes) throw validationFailed(tooLarge);
  const upload = await createUpload(id, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, user);
  after(async () => {
    try {
      await checkUpload(upload.id);
    } catch (error) {
      console.error("[shop-bulk-upload] check failed", upload.id, error);
    }
  });
  return ok({ uploadId: upload.id }, 202);
});
