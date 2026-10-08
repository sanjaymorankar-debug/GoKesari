/**
 * Serves a stored image. Product photos are public and cacheable; return
 * evidence only goes to the customer who uploaded it, the shop the return is
 * for, and staff.
 */
import { NextResponse, type NextRequest } from "next/server";

import { AppError, toClientError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { getImage } from "@/server/services/image-store";
import { isHiddenProductFile, isImageStaff } from "@/server/services/product-images";
import { canViewReturnImage } from "@/server/services/returns";
import { canViewDeliveryProof } from "@/server/services/delivery-proofs";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("NOT_FOUND", "Image not found.");
    const image = await getImage(id);

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
    } else if (image.purpose === "PRODUCT" && (await isHiddenProductFile(image.id))) {
      // F10: a photo awaiting (or refused) approval — its uploader and staff only.
      const user = await getCurrentUser();
      if (!user || (user.id !== image.ownerId && !isImageStaff(user.role))) {
        throw new AppError("NOT_FOUND", "Image not found.");
      }
      cache = "private, no-store";
    }
    return new NextResponse(new Uint8Array(image.data), {
      headers: {
        "Content-Type": image.contentType,
        "Content-Length": String(image.sizeBytes),
        "Cache-Control": cache,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    const { status, body } = toClientError(error);
    return NextResponse.json(body, { status });
  }
}
