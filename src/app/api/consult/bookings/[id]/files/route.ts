/**
 * Private files of a booking (prescriptions, case papers …): encrypted at rest, opened only through a
 * five-minute signed link for the viewer. GET → [{ id, fileName, url }]; POST multipart { file } → { id, signedUrl }.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { bookingFileLinks, uploadBookingFile } from "@/server/consult/files";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok({ files: await bookingFileLinks(z.string().uuid().parse((await context.params).id), user) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`consult-file:${user.id}`, RATE_LIMITS.SELLER_DOCUMENT_UPLOAD);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) throw validationFailed("Choose a file.");
  return ok(await uploadBookingFile(z.string().uuid().parse((await context.params).id), { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, user), 201);
});
