/**
 * GET ?prescriptionId=&latitude=&longitude=&addressId=&fromOrderId= → what the patient can order from a
 * prescription (remaining quantities, online-sale rule), verified medical stores nearest first with open
 * now / rating / favourites, saved addresses, and — for "Send to another store" — the earlier selection.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { rxOrderOptions } from "@/server/health/rx-orders";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const q = request.nextUrl.searchParams;
  const pick = (k: string) => q.get(k) || null;
  return ok(await rxOrderOptions({ prescriptionId: pick("prescriptionId"), latitude: pick("latitude"), longitude: pick("longitude"), addressId: pick("addressId"), fromOrderId: pick("fromOrderId") }, user));
});
