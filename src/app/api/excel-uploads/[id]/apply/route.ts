/** Excel upload — phase two: confirm and apply the validated rows (§24). */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess, requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { excelUploads } from "@/server/db/schema";
import { applyUpload, cancelUpload } from "@/server/services/excel";

async function authorise(uploadId: string) {
  const [upload] = await db
    .select({ shopId: excelUploads.shopId })
    .from(excelUploads)
    .where(eq(excelUploads.id, uploadId))
    .limit(1);
  if (!upload) throw notFound("Upload");

  return requireShopAccess(upload.shopId, {
    anyPermission: PERMISSIONS.EXCEL_UPLOAD_ANY,
  });
}

export const POST = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    // Signed in first: a guest gets 401 before the body or the record is read (TC-SEC-001).
    await requireUser();
    const { id } = await context.params;
    const { user } = await authorise(id);
    return ok(await applyUpload(id, user));
  },
);

/** Discards a validated upload the operator decided not to confirm. */
export const DELETE = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    // Signed in first: a guest gets 401 before the body or the record is read (TC-SEC-001).
    await requireUser();
    const { id } = await context.params;
    const { user } = await authorise(id);
    await cancelUpload(id, user);
    return ok({ cancelled: true });
  },
);
