/**
 * docs/document-upload-2026-10: upload a document (multipart: `file`,
 * `docType`, optional `source=CAMERA`) and read it. PDF, JPEG, PNG or WebP,
 * checked from the bytes. Returns the fields read and any flags; nothing is
 * submitted until the owner confirms.
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { readUploadedDocument } from "@/server/services/document-uploads";

export const dynamic = "force-dynamic";
// Reading a photo takes a few seconds on the server.
export const maxDuration = 60;

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  enforceRateLimit(`seller-document-read:${user.id}`, RATE_LIMITS.SELLER_DOCUMENT_READ);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const docType = form?.get("docType");
  if (!(file instanceof File)) throw validationFailed("Attach the document — upload a file or take a photo.");
  if (typeof docType !== "string") throw validationFailed("Choose which document this is.");

  return ok(
    await readUploadedDocument({
      shopId: id,
      docType,
      file: Buffer.from(await file.arrayBuffer()),
      source: form?.get("source") === "CAMERA" ? "CAMERA" : "FILE",
      actor: user,
    }),
    201,
  );
});
