/**
 * NEW-007: the rider's photo at the door (multipart form: `file`). JPEG, PNG
 * or WebP within the image size limit, checked from the bytes. Only the rider
 * holding the picked-up delivery may upload. Gig worker flow: `kind=PICKUP`
 * is the optional pickup photo (from acceptance until the drop).
 * Module 4: `kind=SIGNATURE` is the customer's signature (PNG from the pad,
 * optional `signerName`) while rule deliveryProof.signatureEnabled is on (404
 * otherwise). Optional `latitude` / `longitude`: kept only while rule
 * deliveryProof.captureGps is on.
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
  // Gig worker flow (feature 9): kind=PICKUP is the optional photo at the shop.
  const rawKind = form?.get("kind");
  const kind = rawKind === "PICKUP" ? "PICKUP" : rawKind === "SIGNATURE" ? "SIGNATURE" : "DELIVERY";
  const text = (key: string) => {
    const v = form?.get(key);
    return typeof v === "string" ? v : null;
  };
  const latitude = text("latitude");
  const longitude = text("longitude");
  const position = latitude && longitude ? { latitude: Number(latitude), longitude: Number(longitude) } : null;
  return ok(
    await uploadDeliveryProof(id, user, Buffer.from(await file.arrayBuffer()), kind, {
      signerName: text("signerName"),
      position,
    }),
    201,
  );
});
