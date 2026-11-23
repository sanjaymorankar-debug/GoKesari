/** docs/dealer-platform phase 5: POST multipart { key, file } — the file of a FILE-type scheme question (PDF/JPEG/PNG/WebP, 5 MB). */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { uploadCustomFile } from "@/server/dealers/custom-fields";
import { requireDealerProgramme } from "@/server/dealers/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  enforceRateLimit(`dealer-custom-file:${user.id}`, RATE_LIMITS.MUTATION);
  const form = await request.formData().catch(() => null);
  const key = form?.get("key");
  const file = form?.get("file");
  if (typeof key !== "string" || !(file instanceof File)) throw validationFailed("Choose the file.");
  return ok({ file: await uploadCustomFile(user, key, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }) }, 201);
});
