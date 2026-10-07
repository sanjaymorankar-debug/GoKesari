/**
 * C5: a rider's own identity documents. GET lists type, date and review
 * status (never the file). POST (multipart: `file`, `docType`) uploads or
 * replaces one. Only an admin can open the files (GET /api/images/{id}).
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listMyRiderDocuments, uploadMyRiderDocument } from "@/server/services/rider-files";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  return ok({ documents: await listMyRiderDocuments(user.id) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  enforceRateLimit(`rider-document:${user.id}`, { limit: 20, windowMs: 10 * 60_000 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const docType = form?.get("docType");
  if (!(file instanceof File)) throw validationFailed("Attach a photo of the document.");
  if (typeof docType !== "string") throw validationFailed("Choose the document type.");
  const document = await uploadMyRiderDocument(user.id, user.role, docType, Buffer.from(await file.arrayBuffer()));
  return ok({ document }, 201);
});
