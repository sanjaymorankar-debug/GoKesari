/**
 * GoKesari Health — "Download my data" (DPDP right of access). The signed-in account holder gets every
 * health record of their own account as one JSON file: patients they manage, consents, timeline,
 * appointments, consultations, prescriptions (with a link to each PDF), document list, medicine orders,
 * rentals, home-care visits, access log and data requests. Only their own account — there is no
 * parameter that names another user. Works while the health rule is off (data rights do not switch off).
 */
import { NextResponse } from "next/server";

import { route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { exportAccountHealthData } from "@/server/health/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireUser();
  enforceRateLimit(`health-export:${user.id}`, { limit: 5, windowMs: 600_000 });
  const data = await exportAccountHealthData(user.id);
  const day = data.generatedAt.slice(0, 10);
  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="gokesari-health-${day}.json"`,
      "Cache-Control": "private, no-store",
    },
  });
});
