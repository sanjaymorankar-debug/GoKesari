/** F10: product photos waiting for review (catalogue staff). */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listPendingImages } from "@/server/services/product-images";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.PRODUCT_MANAGE);
  return ok({ images: await listPendingImages() });
});
