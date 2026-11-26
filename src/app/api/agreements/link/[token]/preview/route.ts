/** The personalised agreement behind an owner signing link (docs/seller-agreements-2026-11); same query as /api/shops/[id]/agreements/preview. */
import type { NextRequest } from "next/server";

import { parseQuery, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { agreementHtmlResponse, clientIp, pdfResponse, previewExtras, previewQuery } from "@/server/legal-agreements/http";
import { previewAgreement, previewAgreementPdf, resolveSigningLink } from "@/server/legal-agreements/signing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = route(async (request: NextRequest, context: RouteContext<{ token: string }>) => {
  const { token } = await context.params;
  enforceRateLimit(`agreement-link-preview:${clientIp(request) ?? "?"}`, RATE_LIMITS.SELLER_DOCUMENT_READ);
  const link = await resolveSigningLink(token);
  const q = parseQuery(request, previewQuery);
  if (q.format === "pdf") {
    const { pdf, filename } = await previewAgreementPdf(link.shopId, previewExtras(q));
    return pdfResponse(pdf, filename);
  }
  return agreementHtmlResponse((await previewAgreement(link.shopId, previewExtras(q))).html);
});
