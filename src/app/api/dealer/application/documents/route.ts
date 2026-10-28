/**
 * POST multipart { docType, file } — the applicant uploads a document (PDF, JPEG, PNG or WebP,
 * up to 5 MB; stored encrypted). docs/dealer-programme, GKS-DR-002.
 */
import type { NextRequest } from "next/server";

import { DEALER_DOC_TYPES, type DealerDocType } from "@/lib/dealers";
import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { uploadDealerDocument } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  enforceRateLimit(`dealer-doc:${user.id}`, { limit: 30, windowMs: 60 * 60_000 });
  const form = await request.formData().catch(() => null);
  const docType = form?.get("docType");
  const file = form?.get("file");
  if (typeof docType !== "string" || !(DEALER_DOC_TYPES as readonly string[]).includes(docType)) throw validationFailed("Choose the document type.");
  if (!(file instanceof File)) throw validationFailed("Attach the document.");
  const bytes = Buffer.from(await file.arrayBuffer());
  return ok({ document: await uploadDealerDocument(user, docType as DealerDocType, { name: file.name, bytes }) });
});
