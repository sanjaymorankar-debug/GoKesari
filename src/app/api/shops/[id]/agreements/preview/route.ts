/**
 * The personalised, unsigned agreement for the viewer (docs/seller-agreements-2026-11):
 * GET ?doc=SELLER_SLA&lang=en|mr|hi&format=html|pdf[&constitution&designation&name&pharmacistName&pharmacistReg]
 * The shop's owner, staff with SHOP_REGISTRATION_MANAGE, or the helper who registered the shop.
 */
import type { NextRequest } from "next/server";

import { forbidden } from "@/lib/errors";
import { parseQuery, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { agreementHtmlResponse, pdfResponse, previewExtras, previewQuery } from "@/server/legal-agreements/http";
import { loadOwner, previewAgreement, previewAgreementPdf } from "@/server/legal-agreements/signing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  const { owner, shop } = await loadOwner(id);
  if (owner.id !== user.id && !can(user.role, PERMISSIONS.SHOP_REGISTRATION_MANAGE) && shop.onboardedByUserId !== user.id) {
    throw forbidden("This shop does not belong to you.");
  }
  const q = parseQuery(request, previewQuery);
  if (q.format === "pdf") {
    enforceRateLimit(`agreement-pdf:${user.id}`, RATE_LIMITS.SELLER_DOCUMENT_READ);
    const { pdf, filename } = await previewAgreementPdf(id, previewExtras(q));
    return pdfResponse(pdf, filename);
  }
  const { html } = await previewAgreement(id, previewExtras(q));
  return agreementHtmlResponse(html);
});
