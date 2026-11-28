/**
 * A shop's agreements (docs/seller-agreements-2026-11). The shop's owner; staff with SHOP_REGISTRATION_MANAGE
 * may read and send the owner a signing link, but never sign.
 *
 *   GET                                  → status, documents to sign, licence blockers, grace, signed history
 *   POST { action: "otp" }               → SMS code to the registered mobile (owner only)
 *   POST { action: "sign", … }           → e-sign with the code (owner only); see signBody
 *   POST { action: "accept", … }         → onboarding v2 registration only: accept with the ticks and the name, no
 *                                          code (owner 27-Nov-2026); any later review or re-sign uses "sign" + OTP
 *   POST { action: "link" }              → staff / the dealer who registered the shop: send the owner a signing link
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden, validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { clientIp, ownerAgreementsView, registrationAcceptBody, signBody } from "@/server/legal-agreements/http";
import { acceptAgreementsAtRegistration, createSigningLink, loadOwner, sendSigningCode, signAgreements } from "@/server/legal-agreements/signing";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function access(shopId: string) {
  const user = await requireUser();
  const { owner, shop } = await loadOwner(shopId);
  const isOwner = owner.id === user.id;
  const isStaff = can(user.role, PERMISSIONS.SHOP_REGISTRATION_MANAGE);
  const isRegisteringHelper = shop.onboardedByUserId === user.id;
  if (!isOwner && !isStaff && !isRegisteringHelper) throw forbidden("This shop does not belong to you.");
  return { user, owner, shop, isOwner, isStaff, isRegisteringHelper };
}

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const a = await access(id);
  const view = await ownerAgreementsView(id);
  return ok({ ...view, viewer: a.isOwner ? "OWNER" : "STAFF", canSign: a.isOwner });
});

const otpBody = z.object({ action: z.literal("otp") });
const linkBody = z.object({ action: z.literal("link") });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const a = await access(id);
  const raw = (await request.json().catch(() => null)) as { action?: string } | null;
  enforceRateLimit(`agreements:${a.user.id}`, RATE_LIMITS.MUTATION);
  switch (raw?.action) {
    case "otp": {
      otpBody.parse(raw);
      if (!a.isOwner) throw forbidden("Only the shop owner can sign. Send the owner a signing link instead.");
      return ok(await sendSigningCode({ shopId: id, owner: a.owner }, clientIp(request)));
    }
    case "sign": {
      if (!a.isOwner) throw forbidden("Only the shop owner can sign. Send the owner a signing link instead.");
      const parsed = signBody.safeParse(raw);
      if (!parsed.success) throw validationFailed(parsed.error.issues[0]?.message ?? "Check the form.");
      const body = parsed.data;
      enforceRateLimit(`agreements-sign:${a.user.id}`, RATE_LIMITS.PAYMENT);
      return ok(
        await signAgreements(
          { shopId: id, owner: a.owner },
          {
            code: body.code,
            signerName: body.signerName,
            designation: body.designation,
            constitution: body.constitution,
            pharmacist: body.pharmacist ?? null,
            accepted: body.accepted.map(({ docType, version }) => ({ docType, version })),
            languageViewed: body.languageViewed,
            ip: clientIp(request),
            userAgent: request.headers.get("user-agent"),
            geo: body.geo ?? null,
          },
        ),
      );
    }
    case "accept": {
      if (!a.isOwner) throw forbidden("Only the shop owner can accept the shop's agreements.");
      const parsed = registrationAcceptBody.safeParse(raw);
      if (!parsed.success) throw validationFailed(parsed.error.issues[0]?.message ?? "Check the form.");
      const body = parsed.data;
      enforceRateLimit(`agreements-sign:${a.user.id}`, RATE_LIMITS.PAYMENT);
      return ok(
        await acceptAgreementsAtRegistration(
          { shopId: id, owner: a.owner },
          {
            signerName: body.signerName,
            designation: body.designation,
            constitution: body.constitution,
            pharmacist: body.pharmacist ?? null,
            accepted: body.accepted.map(({ docType, version }) => ({ docType, version })),
            languageViewed: body.languageViewed,
            ip: clientIp(request),
            userAgent: request.headers.get("user-agent"),
            geo: body.geo ?? null,
            renewalPromise: body.renewalPromise === true,
          },
        ),
      );
    }
    case "link": {
      linkBody.parse(raw);
      if (a.isOwner) throw validationFailed("You are the owner: sign here yourself.");
      const initiatedAs = a.user.role === "ADMIN" ? "ADMIN" : a.isStaff ? "OPERATOR" : "DEALER";
      return ok(await createSigningLink(id, a.user, initiatedAs));
    }
    default:
      throw validationFailed("Unknown action.");
  }
});
