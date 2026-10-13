/**
 * docs/document-upload-2026-10: is the document reader working on this
 * server? Reads a small generated image and reports each stage's time, or
 * where it stopped. Admins and operators with document-review rights only.
 */
import { forbidden } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { readerHealth } from "@/server/kyc/document-reader";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const GET = route(async () => {
  const user = await requireUser();
  if (!can(user.role, PERMISSIONS.SHOP_GST_PAN_VERIFY)) throw forbidden();
  return ok(await readerHealth());
});
