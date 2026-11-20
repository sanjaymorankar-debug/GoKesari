/** GET ?shopId=&from=&to= — earnings from home-care visits (fees, commission, payout) from the consult bookings. */
import type { NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { firmForPage } from "@/server/consult/pages";
import { requireHealthEnabled } from "@/server/health/access";
import { careEarnings } from "@/server/health/care";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  await requireHealthEnabled();
  const sp = request.nextUrl.searchParams;
  const firm = await firmForPage(user, sp.get("shopId"));
  if (!firm) throw notFound("Practice");
  return ok(await careEarnings(firm.shopId, user, { fromKey: sp.get("from") ?? undefined, toKey: sp.get("to") ?? undefined }));
});
