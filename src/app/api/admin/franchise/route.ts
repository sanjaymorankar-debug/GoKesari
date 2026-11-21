/**
 * Admin: the franchise overview — config and its versions, zones (Inactive and the hidden test zone included), zone
 * sets, the area summary, launch counters, franchises, expiring ones, the attribution queue, notifications, the
 * monthly points table and the config audit. Admin and operator may read; only an admin changes anything.
 */
import { ok, route } from "@/server/api/handler";
import { offerView } from "@/server/franchise/booking";
import { franchiseConfig, listConfigVersions } from "@/server/franchise/config";
import { adminAllocations, attributionQueue, configAudit, expiringAreas, notificationLog, pointsTable } from "@/server/franchise/dashboard";
import { requireFranchiseReader } from "@/server/franchise/http";
import { areaSummary, zoneStatusHistory, zoneViews } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireFranchiseReader();
  const config = await franchiseConfig();
  const zones = await zoneViews({ includeTest: true, includeInactive: true });
  return ok({
    me: { role: user.role },
    config,
    versions: await listConfigVersions(),
    offer: await offerView(),
    zones,
    areaSummary: await Promise.all(config.config.zoneSetsEnabled.map(async (code) => ({ code, ...(await areaSummary(code)) }))),
    statusHistory: await zoneStatusHistory(undefined, 200),
    allocations: await adminAllocations(),
    expiring: await expiringAreas(),
    attributions: await attributionQueue(),
    notifications: await notificationLog(100),
    points: await pointsTable(),
    configAudit: await configAudit(),
  });
});
