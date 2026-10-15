/**
 * Bulk product upload (docs/product-import-2026-10) — API v1, shared by the
 * website and the Android / iPhone apps.
 *   GET  → the shop's import history (newest first).
 *   POST multipart `file` (.xlsx, .xlsm or .csv) → 202 { jobId, job, duplicateOf }.
 *        The file is checked and previewed in the background; poll
 *        GET /api/v1/product-imports/{jobId}. Nothing in the shop changes
 *        until POST /api/v1/product-imports/{jobId}/commit.
 * A shop owner may use their own shops only; operators and admins any shop.
 */
import { after, type NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { assertImportAccess, createImportJob, getImportLimits, listShopImports, runParse } from "@/server/services/product-import";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  const shopId = z.string().uuid().parse((await context.params).shopId);
  const user = await requireUser();
  await assertImportAccess(shopId, user);
  return ok({ imports: await listShopImports(shopId) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  const shopId = z.string().uuid().parse((await context.params).shopId);
  const user = await requireUser();
  await assertImportAccess(shopId, user);
  enforceRateLimit(`product-import:${user.id}`, { limit: 30, windowMs: 60 * 60_000 });

  const { maxFileBytes } = await getImportLimits();
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxFileBytes + 1024 * 1024) {
    throw validationFailed(`The file is too large: the limit is ${Math.round(maxFileBytes / (1024 * 1024))} MB.`);
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) throw validationFailed("Choose an Excel (.xlsx, .xlsm) or CSV file to upload.");
  if (file.size > maxFileBytes) {
    throw validationFailed(`The file is too large: the limit is ${Math.round(maxFileBytes / (1024 * 1024))} MB.`);
  }
  const { job, duplicateOf } = await createImportJob(shopId, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, user);
  after(async () => {
    try {
      await runParse(job.id);
    } catch (error) {
      console.error("[product-import] parse failed", job.id, error);
    }
  });
  return ok({ jobId: job.id, job, duplicateOf }, 202);
});
