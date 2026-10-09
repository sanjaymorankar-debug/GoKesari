/**
 * Serves a stored image. Product photos are public and cacheable; return
 * evidence only goes to the customer who uploaded it, the shop the return is
 * for, and staff; dispute photos only to the case's customer, shop and staff. Rider photos and identity documents are access-checked (C5).
 *
 * Module 1: `?size=thumb|medium|large` serves a processed product photo's
 * smaller copies (an image without them is served at its only size). The
 * access checks run on the record before any bytes are read, whether those
 * bytes are in the database or in MEDIA_DIR. Responses carry an ETag, so a
 * browser revalidating a cached photo gets a 304 without the bytes.
 */
import { NextResponse, type NextRequest } from "next/server";

import { AppError, toClientError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { getImageMeta, readImageBytes, type ImageSize } from "@/server/services/image-store";
import { isHiddenProductFile, isImageStaff } from "@/server/services/product-images";
import { canViewReturnImage } from "@/server/services/returns";
import { canViewDeliveryProof } from "@/server/services/delivery-proofs";
import { canViewDisputeImage } from "@/server/services/disputes";
import { canViewRiderKycFile, canViewRiderPhoto } from "@/server/services/rider-files";
import { getRule } from "@/server/services/settings";

export const dynamic = "force-dynamic";

const SIZES: readonly string[] = ["thumb", "medium", "large"] satisfies ImageSize[];

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("NOT_FOUND", "Image not found.");
    const sizeParam = request.nextUrl.searchParams.get("size");
    const size = sizeParam && SIZES.includes(sizeParam) ? (sizeParam as ImageSize) : null;
    const image = await getImageMeta(id);

    let cache = "public, max-age=31536000, immutable";
    if (image.purpose === "RETURN_EVIDENCE") {
      const user = await getCurrentUser();
      if (!user || !(await canViewReturnImage(image.id, image.ownerId, user))) {
        throw new AppError("NOT_FOUND", "Image not found.");
      }
      cache = "private, max-age=300";
    } else if (image.purpose === "DELIVERY_PROOF") {
      // NEW-007: the order's customer and shop, the rider who took it, operations.
      const user = await getCurrentUser();
      if (!user || !(await canViewDeliveryProof(image.id, user))) {
        throw new AppError("NOT_FOUND", "Image not found.");
      }
      cache = "private, max-age=300";
    } else if (image.purpose === "DISPUTE_EVIDENCE") {
      // Event layer: the uploader, support, and the case's customer and shop.
      const user = await getCurrentUser();
      if (!user || !(await canViewDisputeImage(image.id, image.ownerId, user))) {
        throw new AppError("NOT_FOUND", "Image not found.");
      }
      cache = "private, max-age=300";
    } else if (image.purpose === "RIDER_KYC_DOC") {
      // C5: a rider's identity document — admins only, always (each opening audited).
      const user = await getCurrentUser();
      if (!user || !(await canViewRiderKycFile(image.id, user))) {
        throw new AppError("NOT_FOUND", "Image not found.");
      }
      cache = "private, no-store";
    } else if (image.purpose === "PROFILE_PHOTO" && (await getRule("riderFiles")).protectPhotos) {
      // C5: a rider's photo — the rider, rider staff, and staff of a verified society listing the rider.
      const user = await getCurrentUser();
      if (!user || !(await canViewRiderPhoto(image, user))) {
        throw new AppError("NOT_FOUND", "Image not found.");
      }
      cache = "private, max-age=300";
    } else if (image.purpose === "PRODUCT" && (await isHiddenProductFile(image.id))) {
      // F10: a photo awaiting (or refused) approval — its uploader and staff only.
      const user = await getCurrentUser();
      if (!user || (user.id !== image.ownerId && !isImageStaff(user.role))) {
        throw new AppError("NOT_FOUND", "Image not found.");
      }
      cache = "private, no-store";
    }
    const served = await readImageBytes(image, size);
    const headers = {
      "Content-Type": served.contentType,
      "Cache-Control": cache,
      ETag: served.etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    };
    if (request.headers.get("if-none-match") === served.etag) {
      return new NextResponse(null, { status: 304, headers });
    }
    return new NextResponse(new Uint8Array(served.bytes), {
      headers: { ...headers, "Content-Length": String(served.bytes.length) },
    });
  } catch (error) {
    const { status, body } = toClientError(error);
    return NextResponse.json(body, { status });
  }
}
