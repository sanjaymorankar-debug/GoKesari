/** Signature or stamp image: multipart { file, which: signature|stamp } (stored encrypted). */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { uploadDoctorImage } from "@/server/health/doctors";
import { fileFromForm, uuidParam } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ memberId: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`health-doctor-image:${user.id}`, RATE_LIMITS.SELLER_DOCUMENT_UPLOAD);
  const { form, file } = await fileFromForm(request);
  const which = form?.get("which");
  if (!file) throw validationFailed("Choose an image.");
  if (which !== "signature" && which !== "stamp") throw validationFailed("Choose signature or stamp.");
  await uploadDoctorImage(await uuidParam(context, "memberId"), which, Buffer.from(await file.arrayBuffer()), user);
  return ok({ saved: true }, 201);
});
