/**
 * Admin-tunable business rules (OTP limits, dispatch retry, earnings, returns,
 * suspension policy...). Admin only; every write is audited.
 *
 * GET               → every rule with its default, effective value, override flag
 * PUT  { key, value } → override (partial values are completed from defaults)
 * DELETE ?key=      → restore the default
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { RULES, type RuleKey } from "@/server/config/rules";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { getRule, listRules, resetRule, setRule } from "@/server/services/settings";
import { fourEyeAdminOn, requestFourEye, FOUR_EYE_TYPES } from "@/server/approvals";
import { changedTaxFields, isTaxRuleKey } from "@/server/tax-register/rules";
import { refuseDirectTaxEdit } from "@/server/tax-register/changes";

export const dynamic = "force-dynamic";

const ruleKey = z.string().refine((k): k is RuleKey => k in RULES, "Unknown setting.");
const putSchema = z.object({ key: ruleKey, value: z.record(z.string(), z.unknown()) });

export const GET = route(async () => {
  await requireRole("ADMIN");
  return ok({ rules: await listRules() });
});

export const PUT = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, putSchema);
  // Owner, 21-Nov-2026: a territory and a franchise are the same thing — territories are sold and paid only as
  // franchise zones (Admin → Franchise), so the older territory rule cannot be switched back on (no double recurring).
  // docs/tax-register: with tax_register on, the tax fields of a setting change only through the register.
  if (isTaxRuleKey(body.key)) {
    const changed = changedTaxFields(body.key, (await getRule(body.key as RuleKey)) as Record<string, unknown>, body.value);
    if (changed.length) await refuseDirectTaxEdit(`${body.key} (${changed.join(", ")})`);
  }
  if (body.key === "territoryDealer" && body.value.enabled === true) throw validationFailed("Territories are now franchise zones: sell and manage them in Admin → Franchise.");
  // docs/rbac: with rbac_v2_four_eye_admin on, a second admin approves rule changes (thresholds, fees, charges) first.
  if (await fourEyeAdminOn()) {
    return ok(
      await requestFourEye(FOUR_EYE_TYPES.RULE_SET, admin, {
        subjectType: "rule",
        subjectId: body.key,
        title: `Change setting ${body.key}`,
        reason: `Setting ${body.key} changed`,
        payload: { key: body.key, value: body.value },
      }),
      202,
    );
  }
  return ok({ key: body.key, value: await setRule(body.key as RuleKey, body.value, admin) });
});

export const DELETE = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const key = new URL(request.url).searchParams.get("key");
  if (!key || !(key in RULES)) throw validationFailed("Unknown setting.");
  if (isTaxRuleKey(key)) await refuseDirectTaxEdit(`Resetting ${key}`);
  if (await fourEyeAdminOn()) {
    return ok(
      await requestFourEye(FOUR_EYE_TYPES.RULE_RESET, admin, { subjectType: "rule", subjectId: key, title: `Reset setting ${key} to defaults`, reason: `Setting ${key} reset`, payload: { key } }),
      202,
    );
  }
  await resetRule(key as RuleKey, admin);
  return ok({ key, reset: true });
});
