/** GET — the home-care visits of everyone in my family (newest first). */
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled } from "@/server/health/access";
import { patientCareVisits } from "@/server/health/care";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  await requireHealthEnabled();
  return ok({ visits: await patientCareVisits(user) });
});
