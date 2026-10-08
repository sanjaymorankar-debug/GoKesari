/**
 * File sync (myBillBook, Vyapar, other software): item exports.
 *   GET  → recent uploads.
 *   POST multipart `file` (.xlsx or .csv, up to 5 MB) → headings, sample rows
 *        and the suggested column mapping. Nothing changes until apply.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireIntegrationAccess } from "@/server/integrations/connections";
import { createItemImport, listItemImports, MAX_IMPORT_BYTES } from "@/server/integrations/file-sync";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  await requireIntegrationAccess(id, "view");
  return ok({ uploads: await listItemImports(id) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireIntegrationAccess(id, "operate");
  enforceRateLimit(`integration-import:${actor.id}`, { limit: 20, windowMs: 60 * 60_000 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_IMPORT_BYTES + 512 * 1024) {
    throw validationFailed("The file is larger than 5 MB.");
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) throw validationFailed("Choose your item export file (.xlsx or .csv).");
  const upload = await createItemImport(id, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, actor);
  return ok(upload, 201);
});
