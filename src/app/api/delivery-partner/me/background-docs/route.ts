/**
 * Gig worker flow (feature 3): the partner's police verification form and
 * character certificate. GET lists type and review status (never the file).
 * POST (multipart: `file`, `docType`) uploads or replaces one — PDF, JPG or
 * PNG, at most rule riderVerification.maxDocumentBytes, stored encrypted.
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listMyBackgroundDocs, uploadMyBackgroundDoc } from "@/server/services/rider-background-docs";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  return ok({ documents: await listMyBackgroundDocs(user.id) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  enforceRateLimit(`rider-background-doc:${user.id}`, { limit: 20, windowMs: 10 * 60_000 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const docType = form?.get("docType");
  if (!(file instanceof File)) throw validationFailed("Attach the document (PDF, JPG or PNG).");
  if (typeof docType !== "string") throw validationFailed("Choose the document type.");
  const document = await uploadMyBackgroundDoc(user.id, user.role, docType, Buffer.from(await file.arrayBuffer()));
  return ok({ document }, 201);
});
