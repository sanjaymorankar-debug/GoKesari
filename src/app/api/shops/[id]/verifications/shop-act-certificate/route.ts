/**
 * Shop Act certificate / Form G receipt upload (multipart: `file`, `number`,
 * `consent=true`). PDF, JPEG, PNG or WebP up to 5 MB, checked from the bytes.
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { uploadShopActCertificate } from "@/server/services/seller-verification";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  enforceRateLimit(`seller-document-upload:${user.id}`, RATE_LIMITS.SELLER_DOCUMENT_UPLOAD);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const number = form?.get("number");
  if (!(file instanceof File)) throw validationFailed("Attach the certificate file.");
  if (typeof number !== "string" || !number.trim()) throw validationFailed("Enter the number printed on the certificate.");
  if (form?.get("consent") !== "true") throw validationFailed("Please agree to the verification consent.");

  return ok(
    await uploadShopActCertificate({
      shopId: id,
      number,
      file: Buffer.from(await file.arrayBuffer()),
      consentGiven: true,
      actor: user,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    }),
    201,
  );
});
