/** POST multipart { memberId, file } — a consultant's registration certificate (Medical / Bar Council, ICAI …), encrypted. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { uploadMemberDocument } from "@/server/consult/setup";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`consult-doc:${user.id}`, RATE_LIMITS.SELLER_DOCUMENT_UPLOAD);
  const shopId = z.string().uuid().parse((await context.params).shopId);
  const form = await request.formData().catch(() => null);
  const memberId = z.string().uuid().safeParse(form?.get("memberId"));
  const file = form?.get("file");
  if (!memberId.success) throw validationFailed("Choose the consultant.");
  if (!(file instanceof File) || file.size === 0) throw validationFailed("Choose the certificate file.");
  return ok(await uploadMemberDocument(shopId, memberId.data, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, user), 201);
});
