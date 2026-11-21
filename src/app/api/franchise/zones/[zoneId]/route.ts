/** Public: one zone's page (§5.4) — tier, fee, % vs average, business and source, areas, description, slots. */
import { ok, route, type RouteContext } from "@/server/api/handler";
import { offerView } from "@/server/franchise/booking";
import { listAreas, zoneView } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: Request, { params }: RouteContext<{ zoneId: string }>) => {
  const zoneId = decodeURIComponent((await params).zoneId).toUpperCase();
  const zone = await zoneView(zoneId);
  return ok({ zone, areas: await listAreas({ zoneId }), offer: await offerView() });
});
