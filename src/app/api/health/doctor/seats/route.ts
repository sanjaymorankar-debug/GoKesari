/** The doctor seats I can run (my own; as a clinic owner, my clinic's doctors) with verification status. */
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled } from "@/server/health/access";
import { doctorSeatsFor } from "@/server/health/doctors";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  await requireHealthEnabled();
  return ok({ seats: await doctorSeatsFor(user) });
});
