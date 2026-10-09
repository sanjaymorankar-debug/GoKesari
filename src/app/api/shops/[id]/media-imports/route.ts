/**
 * Bulk photos and descriptions for a shop (Module 1, docs/three-modules-2026-10).
 *   GET  → the shop's recent uploads.
 *   POST multipart: `zip` (photos named SKU.jpg / SKU_2.jpg or by barcode),
 *        `csv` (sku_or_barcode, short_description, long_description), either
 *        or both, and `photoMode` REPLACE (default) or ADD. Checks and matches
 *        everything and returns the preview; nothing live changes until
 *        POST /api/shops/{id}/media-imports/{importId}/apply.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { createMediaImport, listMediaImports } from "@/server/services/shop-media-import";
import { getRule } from "@/server/services/settings";
import { requireShopCatalogueAccess } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  await requireShopCatalogueAccess(id);
  return ok({ uploads: await listMediaImports(id) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireShopCatalogueAccess(id);
  enforceRateLimit(`shop-media-import:${actor.id}`, { limit: 10, windowMs: 60 * 60_000 });

  const { zipMaxBytes } = await getRule("shopProductMedia");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > zipMaxBytes + 6 * 1024 * 1024) {
    throw validationFailed(`The upload is too large: the ZIP can be at most ${Math.round(zipMaxBytes / (1024 * 1024))} MB.`);
  }
  const form = await request.formData().catch(() => null);
  if (!form) throw validationFailed("Choose a ZIP of photos, a CSV of descriptions, or both.");
  const zip = form.get("zip");
  const csv = form.get("csv");
  const mode = form.get("photoMode") === "ADD" ? "ADD" : "REPLACE";
  const asUpload = async (value: FormDataEntryValue | null) =>
    value instanceof File && value.size > 0 ? { name: value.name.slice(0, 200), bytes: Buffer.from(await value.arrayBuffer()) } : null;
  const preview = await createMediaImport(id, { zip: await asUpload(zip), csv: await asUpload(csv) }, mode, actor);
  return ok(preview, 201);
});
