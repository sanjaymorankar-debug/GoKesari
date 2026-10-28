/**
 * Feature flags (docs/dealer-programme, step 1). ADMIN only — everyone else gets
 * 403 here, and the service checks the role again.
 *
 * GET                                             → every flag, the districts, the last changes
 * PUT { key, enabled, districtCodes|null, reason } → saved and logged (who, old, new, reason, when)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { FEATURE_FLAG_KEYS } from "@/server/db/schema";
import { getFeatureFlags, listFeatureFlagChanges, setFeatureFlag } from "@/server/services/feature-flags";
import { listDistricts } from "@/server/services/geo-areas";

export const dynamic = "force-dynamic";

const putSchema = z.object({
  key: z.enum(FEATURE_FLAG_KEYS),
  enabled: z.boolean(),
  districtCodes: z.array(z.string().max(48)).max(100).nullable(),
  reason: z.string().max(500),
});

export const GET = route(async () => {
  await requireRole("ADMIN");
  const [flags, changes, districts] = await Promise.all([getFeatureFlags(), listFeatureFlagChanges({ limit: 30 }), listDistricts()]);
  return ok({
    flags: Object.values(flags),
    changes,
    districts: districts.map((d) => ({ code: d.code, name: d.name, status: d.status })),
  });
});

export const PUT = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, putSchema);
  const result = await setFeatureFlag(body.key, { enabled: body.enabled, districtCodes: body.districtCodes }, body.reason, admin);
  const [last] = await listFeatureFlagChanges({ key: body.key, limit: 1 });
  return ok({ ...result, lastChange: last ?? null });
});
