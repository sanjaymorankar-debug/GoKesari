/** The doctor's signature on a printed prescription (?rx=<prescription id>): only for someone who may open that prescription. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { fileResponse, uuidParam } from "@/server/health/http";
import { signatureForPrescription } from "@/server/health/prescriptions";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ memberId: string }>) => {
  const user = await requireUser();
  const rx = z.string().uuid().parse(request.nextUrl.searchParams.get("rx"));
  const img = await signatureForPrescription(rx, await uuidParam(context, "memberId"), user);
  if (!img) throw notFound("Signature");
  return fileResponse(img, "image/jpeg", "signature.jpg");
});
