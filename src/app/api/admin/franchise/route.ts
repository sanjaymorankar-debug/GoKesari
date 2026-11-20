/**
 * Admin: the franchise overview (brief §10) — config and its versions, zones (with the hidden test zone),
 * cluster summary, launch counters, allocations, expiring areas and alerts, the attribution queue and the
 * notification log. Admin and operator may read; only an admin changes anything (the other routes).
 */
import { ok, route } from "@/server/api/handler";
import { offerView } from "@/server/franchise/booking";
import { publishedFormula } from "@/server/franchise/commission";
import { franchiseConfig, listConfigVersions } from "@/server/franchise/config";
import { adminAllocations, attributionQueue, expiringAreas, notificationLog } from "@/server/franchise/dashboard";
import { isSuperAdmin, requireFranchiseReader } from "@/server/franchise/http";
import { clusterSummary, listClusters, zoneViews } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireFranchiseReader();
  const zones = await zoneViews({ includeTest: true });
  return ok({
    me: { role: user.role, superAdmin: user.role === "ADMIN" && isSuperAdmin(user.email) },
    config: await franchiseConfig(),
    versions: await listConfigVersions(),
    offer: await offerView(),
    zones,
    clusters: clusterSummary(zones, await listClusters()),
    allocations: await adminAllocations(),
    expiring: await expiringAreas(),
    attributions: await attributionQueue(),
    notifications: await notificationLog(100),
    formula: await publishedFormula(),
  });
});
