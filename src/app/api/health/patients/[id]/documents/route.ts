/** Upload an older report: multipart { file, title, kind, documentDate?, providerName? } (tagged "patient uploaded"). */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled } from "@/server/health/access";
import { fileFromForm, uuidParam } from "@/server/health/http";
import { uploadPatientDocument } from "@/server/health/records";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  await requireHealthEnabled();
  enforceRateLimit(`health-upload:${user.id}`, RATE_LIMITS.SELLER_DOCUMENT_UPLOAD);
  const { form, file } = await fileFromForm(request);
  if (!file) throw validationFailed("Choose a file.");
  const meta = { title: form?.get("title"), kind: form?.get("kind"), documentDate: form?.get("documentDate") || null, providerName: form?.get("providerName") || null };
  return ok(await uploadPatientDocument(await uuidParam(context, "id"), meta, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, user), 201);
});
