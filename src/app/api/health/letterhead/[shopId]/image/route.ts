/** Letterhead image: multipart { file (empty to remove), which: header|footer|background, member? }. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { uuidParam } from "@/server/health/http";
import { uploadLetterheadImage } from "@/server/health/letterheads";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`health-letterhead-image:${user.id}`, RATE_LIMITS.SELLER_DOCUMENT_UPLOAD);
  const form = await request.formData().catch(() => null);
  const which = form?.get("which");
  if (which !== "header" && which !== "footer" && which !== "background") throw validationFailed("Choose header, footer or background.");
  const member = form?.get("member");
  const file = form?.get("file");
  const bytes = file instanceof File ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
  await uploadLetterheadImage(await uuidParam(context, "shopId"), typeof member === "string" && member ? z.string().uuid().parse(member) : null, which, bytes, user);
  return ok({ saved: true });
});
