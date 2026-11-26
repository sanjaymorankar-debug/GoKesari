/**
 * Owner signing link (docs/seller-agreements-2026-11): staff or a dealer registered the shop and sent its
 * owner this link. No sign-in: the link token plus the SMS code to the owner's registered mobile prove the
 * owner. Only the owner's own shop and own documents are reachable through it.
 *
 *   GET                     → the same view as /api/shops/[id]/agreements (owner view)
 *   POST { action: "otp" }  → code to the registered mobile
 *   POST { action: "sign" } → sign (see signBody)
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { clientIp, ownerAgreementsView, signBody } from "@/server/legal-agreements/http";
import { resolveSigningLink, sendSigningCode, signAgreements } from "@/server/legal-agreements/signing";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const GET = route(async (request: NextRequest, context: RouteContext<{ token: string }>) => {
  const { token } = await context.params;
  enforceRateLimit(`agreement-link:${clientIp(request) ?? "?"}`, RATE_LIMITS.MUTATION);
  const link = await resolveSigningLink(token);
  const view = await ownerAgreementsView(link.shopId);
  return ok({ ...view, shopId: link.shopId, viewer: "OWNER", canSign: true, history: [] });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ token: string }>) => {
  const { token } = await context.params;
  const ip = clientIp(request);
  enforceRateLimit(`agreement-link:${ip ?? "?"}`, RATE_LIMITS.MUTATION);
  const link = await resolveSigningLink(token);
  const raw = (await request.json().catch(() => null)) as { action?: string } | null;
  const ctx = { shopId: link.shopId, owner: link.owner, linkRequestId: link.requestId };
  if (raw?.action === "otp") return ok(await sendSigningCode(ctx, ip));
  if (raw?.action === "sign") {
    const parsed = signBody.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error.issues[0]?.message ?? "Check the form.");
    const b = parsed.data;
    enforceRateLimit(`agreements-sign-link:${link.requestId}`, RATE_LIMITS.PAYMENT);
    return ok(
      await signAgreements(ctx, {
        code: b.code,
        signerName: b.signerName,
        designation: b.designation,
        constitution: b.constitution,
        pharmacist: b.pharmacist ?? null,
        accepted: b.accepted.map(({ docType, version }) => ({ docType, version })),
        languageViewed: b.languageViewed,
        ip,
        userAgent: request.headers.get("user-agent"),
        geo: b.geo ?? null,
      }),
    );
  }
  throw validationFailed("Unknown action.");
});
