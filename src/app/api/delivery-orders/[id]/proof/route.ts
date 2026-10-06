/**
 * NEW-007: the rider's photo at the door (multipart form: `file`). JPEG, PNG
 * or WebP within the image size limit, checked from the bytes. Only the rider
 * holding the picked-up delivery may upload.
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { uploadDeliveryProof } from "@/server/services/delivery-proofs";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  enforceRateLimit(`delivery-proof:${user.id}`, { limit: 20, windowMs: 10 * 60_000 });
  const { id } = await context.params;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw validationFailed("Attach a photo of the delivered order.");
  return ok(await uploadDeliveryProof(id, user, Buffer.from(await file.arrayBuffer())), 201);
});
