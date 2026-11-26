/**
 * Agreement settings (docs/seller-agreements-2026-11): the company e-seal image.
 *   GET   → the current e-seal image (CONSENT_VIEW)
 *   POST  multipart file (PNG / JPEG ≤ 1 MB) → becomes the e-seal on signed copies from now on (ADMIN)
 * The other settings (signatory, grace days, CC, fee figures) are rule sellerAgreements (Admin → Settings).
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { notFound, validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission, requireRole } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { readESeal, uploadESeal } from "@/server/legal-agreements/admin";
import { getRule } from "@/server/services/settings";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.CONSENT_VIEW);
  const { eSealAssetId } = await getRule("sellerAgreements");
  const seal = eSealAssetId ? await readESeal(eSealAssetId) : null;
  if (!seal) throw notFound("E-seal");
  return new NextResponse(new Uint8Array(seal.data), { headers: { "Content-Type": seal.contentType, "Cache-Control": "private, no-store" } });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireRole("ADMIN");
  enforceRateLimit(`agreement-seal:${user.id}`, RATE_LIMITS.MUTATION);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw validationFailed("Choose the e-seal image (PNG or JPEG).");
  return ok(await uploadESeal(Buffer.from(await file.arrayBuffer()), file.type, user));
});
