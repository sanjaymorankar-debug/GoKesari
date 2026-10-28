/**
 * GET [?salesperson=<id>] — the approved dealer's code (or one of their employees'), with the
 * share link (Add my shop, code filled in), a WhatsApp share link and the QR as SVG.
 * docs/dealer-programme, GKS-DR-003.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { activeCodeFor, codeQrSvg, shareLinkFor, whatsappShareFor } from "@/server/dealers/codes";
import { originOf, requireDealerProgramme } from "@/server/dealers/http";
import { listSalespeople, requireApprovedDealer } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  const dealer = await requireApprovedDealer(user);
  const raw = request.nextUrl.searchParams.get("salesperson");
  const salespersonId = raw ? z.string().uuid().parse(raw) : null;
  let who = dealer.legalName;
  if (salespersonId) {
    const person = (await listSalespeople(dealer.id)).find((p) => p.id === salespersonId);
    if (!person) throw notFound("Employee");
    who = person.name;
  }
  const code = await activeCodeFor(dealer.id, salespersonId);
  if (!code) throw notFound("Active code");
  const origin = originOf(request);
  return ok({ code, shareLink: shareLinkFor(origin, code), whatsapp: whatsappShareFor(origin, code, who), qrSvg: await codeQrSvg(origin, code) });
});
