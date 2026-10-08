/**
 * Excel upload — phase one: validate and preview (§2.3, §6, §24).
 *
 * Takes multipart/form-data because this is a real file upload. Nothing is
 * written to the shop's live prices here; the response is a preview the caller
 * must explicitly confirm via POST /api/excel-uploads/[id]/apply.
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { MAX_UPLOAD_BYTES, validateUpload } from "@/server/services/excel";

export const POST = route(async (request: NextRequest) => {
  const form = await request.formData().catch(() => null);
  if (!form) throw validationFailed("Expected a multipart file upload.");

  const shopId = String(form.get("shopId") ?? "");
  if (!shopId) throw validationFailed("shopId is required.");

  const file = form.get("file");
  if (!(file instanceof File)) throw validationFailed("No file was uploaded.");
  if (file.size === 0) throw validationFailed("The uploaded file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw validationFailed(
      `File is too large. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
  }

  // Ownership first: an operator may upload for any shop they can manage, an
  // owner only for their own. The shopId in the body is never trusted alone.
  const { user } = await requireShopAccess(shopId, {
    anyPermission: PERMISSIONS.EXCEL_UPLOAD_ANY,
  });

  const uploadType = form.get("uploadType") === "GOODS" ? "GOODS" : "PRICES";

  const preview = await validateUpload(
    {
      shopId,
      fileName: file.name,
      buffer: await file.arrayBuffer(),
      uploadType,
    },
    user,
  );
  return ok(preview, 201);
});
