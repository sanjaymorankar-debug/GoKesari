/**
 * docs/document-upload-2026-10: "Verify & Approve" — the owner submits the
 * reviewed fields. Re-checked on the server, then handed to seller
 * verification and/or the legal-documents register.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { confirmUploadedDocument } from "@/server/services/document-uploads";

export const dynamic = "force-dynamic";

const body = z.object({
  number: z.string().trim().min(1, "Enter the document number.").max(60),
  name: z.string().trim().max(120).nullish(),
  address: z.string().trim().max(300).nullish(),
  validFrom: z.string().trim().max(10).nullish(),
  validUntil: z.string().trim().max(10).nullish(),
  issuingCouncil: z.string().trim().max(120).nullish(),
  licenceName: z.string().trim().max(80).nullish(),
  consent: z.literal(true, { message: "Please agree to the verification consent." }),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string; uploadId: string }>) => {
  const { id, uploadId } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  enforceRateLimit(`seller-document-upload:${user.id}`, RATE_LIMITS.SELLER_DOCUMENT_UPLOAD);
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw validationFailed(parsed.error.issues[0]?.message ?? "Check the details and try again.");
  const { consent, ...fields } = parsed.data;
  return ok(
    await confirmUploadedDocument({
      shopId: id,
      uploadId,
      fields,
      consentGiven: consent,
      actor: user,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    }),
  );
});
