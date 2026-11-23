/**
 * Dealer platform phase 1 (docs/dealer-platform/; CF-011 reuse, owner 23-Nov-2026 "integrate this with dealer
 * module"): the signed-in dealer uploads or removes his own logo.
 *   POST   multipart form `file` (JPEG / PNG / WebP) → stored like a product photo, set as dealers.logo_url
 *   DELETE clears the logo
 * Same flag as the shop logo (`shop_logo_upload_enabled`), checked for the dealer's own district (his PIN code),
 * so a flag limited to some districts reaches only dealers there. Answers `{ logoUrl }` like the shop route, so
 * the same card (ShopLogoUpload with `endpoint`) drives both.
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { SHOP_LOGO_FLAG } from "@/lib/delta/shop-logo";
import { forbidden, validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { dealers, type Dealer } from "@/server/db/schema";
import { getDealerForUser } from "@/server/dealers/service";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { featureNotAvailable, flagCoversShop, getFeatureFlag } from "@/server/services/feature-flags";
import { imageUrl, saveImage } from "@/server/services/image-store";

export const dynamic = "force-dynamic";

const CLOSED = ["TERMINATED"];

async function myDealer(): Promise<{ user: Awaited<ReturnType<typeof requireUser>>; dealer: Dealer }> {
  const user = await requireUser();
  const dealer = await getDealerForUser(user.id);
  if (!dealer || dealer.isInternal || CLOSED.includes(dealer.status)) throw forbidden("Only a GoKesari dealer can set a dealer logo.");
  if (!(await flagCoversShop(await getFeatureFlag(SHOP_LOGO_FLAG), { pincode: dealer.pincode }))) throw featureNotAvailable(SHOP_LOGO_FLAG);
  return { user, dealer };
}

export const POST = route(async (request: NextRequest) => {
  const { user, dealer } = await myDealer();
  enforceRateLimit(`dealer-logo:${user.id}`, { limit: 10, windowMs: 10 * 60_000 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw validationFailed("Attach an image file.");

  // Same checks as every other upload: real type from the bytes, size and pixel limits (rule images).
  const image = await saveImage(Buffer.from(await file.arrayBuffer()), { purpose: "PRODUCT", ownerId: user.id });
  const logoUrl = imageUrl(image.id);
  await db.update(dealers).set({ logoUrl, updatedAt: new Date() }).where(eq(dealers.id, dealer.id));
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.IMAGE_UPLOADED,
    entityType: "stored_image",
    entityId: image.id,
    previousValue: { logoUrl: dealer.logoUrl },
    newValue: { purpose: "DEALER_LOGO", dealerId: dealer.id, bytes: image.sizeBytes, width: image.width, height: image.height },
  });
  return ok({ logoUrl }, 201);
});

export const DELETE = route(async () => {
  const { user, dealer } = await myDealer();
  await db.update(dealers).set({ logoUrl: null, updatedAt: new Date() }).where(eq(dealers.id, dealer.id));
  await recordAudit({ actorId: user.id, actorRole: user.role, action: AUDIT_ACTIONS.DEALER_APPLICATION_SAVED, entityType: "dealer", entityId: dealer.id, previousValue: { logoUrl: dealer.logoUrl }, newValue: { logoUrl: null, purpose: "DEALER_LOGO" } });
  return ok({ logoUrl: null });
});
