/**
 * A shop's mandatory legal documents (docs/four-features-2026-10, feature 2).
 * The shop's owner, or a reviewer (SHOP_GST_PAN_VERIFY).
 *
 *   GET   → what the shop must hold, each document's state and deadline
 *   POST  multipart: docType (FSSAI | DRUG_LICENCE | MEDICAL_REGISTRATION),
 *         number, expiryDate (FSSAI, drug licence), issuingCouncil (medical
 *         registration), file (PDF / JPEG / PNG / WebP, ≤ 5 MB, checked from the bytes)
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { LEGAL_DOC_KEYS, type LegalDocKey } from "@/lib/legal-documents";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getShopLegalStatus, submitLegalDocument } from "@/server/services/legal-documents";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  return ok(await getShopLegalStatus(id));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  enforceRateLimit(`legal-document-upload:${user.id}`, RATE_LIMITS.SELLER_DOCUMENT_UPLOAD);

  const form = await request.formData().catch(() => null);
  const docType = form?.get("docType");
  const number = form?.get("number");
  const file = form?.get("file");
  if (typeof docType !== "string" || !(LEGAL_DOC_KEYS as readonly string[]).includes(docType)) {
    throw validationFailed("Choose which document you are uploading.");
  }
  if (typeof number !== "string" || !number.trim()) {
    throw validationFailed("Enter the number printed on the document.", { fields: { number: "Required." } });
  }
  if (!(file instanceof File)) throw validationFailed("Attach a copy of the document.", { fields: { file: "Required." } });
  const text = (key: string) => {
    const value = form?.get(key);
    return typeof value === "string" ? value : null;
  };

  return ok(
    await submitLegalDocument({
      shopId: id,
      docType: docType as LegalDocKey,
      number,
      expiryDate: text("expiryDate"),
      issuingCouncil: text("issuingCouncil"),
      file: Buffer.from(await file.arrayBuffer()),
      actor: user,
    }),
    201,
  );
});
