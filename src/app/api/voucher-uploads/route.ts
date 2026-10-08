/** Voucher list upload — phase one: validate and preview (§16). */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { validateVoucherUpload } from "@/server/services/vouchers";
import { MAX_UPLOAD_BYTES } from "@/server/services/excel";

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.VOUCHER_UPLOAD);

  const form = await request.formData().catch(() => null);
  if (!form) throw validationFailed("Expected a multipart file upload.");

  const file = form.get("file");
  if (!(file instanceof File)) throw validationFailed("No file was uploaded.");
  if (file.size === 0) throw validationFailed("The uploaded file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw validationFailed(`File is too large. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  }

  const preview = await validateVoucherUpload(
    { fileName: file.name, buffer: await file.arrayBuffer() },
    user,
  );
  return ok(preview, 201);
});
