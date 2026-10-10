/**
 * Referral settings (docs/nearby-referral-2026-10, feature 2). ADMIN only —
 * operators, shop owners and customers get 403 here, and the service checks
 * the role again.
 *
 * GET                 → both settings with when they were set, and the last changes
 * PUT { key, value }  → value MANDATORY | OPTIONAL; logged (who, old, new, when)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { REFERRAL_REQUIREMENTS, REFERRAL_SETTING_KEYS } from "@/server/db/schema";
import { getReferralSettings, listReferralSettingChanges, setReferralSetting } from "@/server/services/referral-settings";

export const dynamic = "force-dynamic";

const putSchema = z.object({ key: z.enum(REFERRAL_SETTING_KEYS), value: z.enum(REFERRAL_REQUIREMENTS) });

export const GET = route(async () => {
  await requireRole("ADMIN");
  const [settings, changes] = await Promise.all([getReferralSettings(), listReferralSettingChanges({ limit: 20 })]);
  return ok({ settings: Object.values(settings), changes });
});

export const PUT = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, putSchema);
  const result = await setReferralSetting(body.key, body.value, admin);
  const [last] = await listReferralSettingChanges({ key: body.key, limit: 1 });
  return ok({ ...result, lastChange: last ?? null });
});
