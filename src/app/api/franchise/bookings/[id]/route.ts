/** DELETE — give up a reservation before paying: its slots are free at once. */
import { noContent, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { cancelReservation } from "@/server/franchise/booking";

export const dynamic = "force-dynamic";

export const DELETE = route(async (_request: Request, { params }: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  await cancelReservation((await params).id, user);
  return noContent();
});
