/** Every-minute partner sweep (docs/hdms-2026-11), run by the existing timeout-sweep cron. Off with hdms_enabled. */
import { isFeatureEnabled } from "@/server/services/feature-flags";

import { pollActiveBookings } from "./bookings";

export async function runPartnerBookingSweep(): Promise<{ skipped: true } | Awaited<ReturnType<typeof pollActiveBookings>>> {
  if (!(await isFeatureEnabled("hdms_enabled", { districtCode: null }))) return { skipped: true };
  return pollActiveBookings();
}
