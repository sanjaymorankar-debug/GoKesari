/**
 * Bulk import into the puja master (brief §6): POST the exported CSV (multipart field "file",
 * or text/csv body). Rows with a product code update it, rows without add a product; bad rows
 * come back in errors[] with their row number and the rest are applied.
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { importMasterCatalogueCsv } from "@/server/puja/admin";
import { requirePujaStaff } from "@/server/puja/route-helpers";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;

export const POST = route(async (request: NextRequest) => {
  const user = await requirePujaStaff();
  let text: string;
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw validationFailed("Choose the CSV file.");
    if (file.size > MAX_BYTES) throw validationFailed("The file is larger than 2 MB.");
    text = await file.text();
  } else {
    text = await request.text();
    if (text.length > MAX_BYTES) throw validationFailed("The file is larger than 2 MB.");
  }
  return ok(await importMasterCatalogueCsv(text, user));
});
