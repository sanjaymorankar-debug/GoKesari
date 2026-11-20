/** A letterhead image for the print view (?which=header|footer&member=): the clinic, or a patient of the clinic printing their copy. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { fileResponse, uuidParam } from "@/server/health/http";
import { effectiveLetterhead } from "@/server/health/letterheads";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  await requireUser();
  const shopId = await uuidParam(context, "shopId");
  const which = z.enum(["header", "footer", "background"]).parse(request.nextUrl.searchParams.get("which"));
  const m = request.nextUrl.searchParams.get("member");
  const lh = await effectiveLetterhead(shopId, m && /^[0-9a-f-]{36}$/.test(m) ? m : null);
  // Clinic branding (not patient data): any signed-in user may load it for printing.
  const img = which === "header" ? lh.headerImage : which === "footer" ? lh.footerImage : lh.backgroundImage;
  if (!img) throw notFound("Image");
  return fileResponse(img, "image/jpeg", `${which}.jpg`);
});
