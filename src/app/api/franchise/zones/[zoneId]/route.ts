/** Public: one zone's card (brief §4.3) — estimates with the disclosure, fee, validity, slots. */
import { ESTIMATE_DISCLOSURE } from "@/lib/franchise";
import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { offerView } from "@/server/franchise/booking";
import { zoneViews } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: Request, { params }: RouteContext<{ zoneId: string }>) => {
  const { zoneId } = await params;
  const [zone] = await zoneViews({ zoneIds: [decodeURIComponent(zoneId).toUpperCase()] });
  if (!zone) throw notFound("Zone");
  return ok({ zone, offer: await offerView(), disclosure: ESTIMATE_DISCLOSURE });
});
