/** The check-in QR for my booking (shown at the clinic; scanning it checks me in). */
import type { NextRequest } from "next/server";
import QRCode from "qrcode";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { checkInQrPayload } from "@/server/health/booking";
import { uuidParam } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_r: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const payload = await checkInQrPayload(await uuidParam(context, "id"), user);
  const svg = await QRCode.toString(payload, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return ok({ code: payload.split(":").pop(), svg });
});
