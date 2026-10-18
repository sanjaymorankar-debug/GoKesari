/** GET — a stored (resized) product image by its asset id, for staff (PMD_VIEW) (batch-2026-10 WS-D, F9.1.4). */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { pmdImageAssets } from "@/server/db/schema";
import { readObject } from "@/server/pmd/object-store";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ key: string }>) => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  const id = z.string().uuid().parse((await context.params).key);
  const [asset] = await db.select().from(pmdImageAssets).where(eq(pmdImageAssets.id, id));
  if (!asset?.objectKey) throw notFound("Image");
  const object = await readObject(asset.objectStore, asset.objectKey);
  if (!object) throw notFound("Image");
  return new Response(new Uint8Array(object.bytes), {
    headers: { "Content-Type": object.contentType, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
  }) as never;
});
