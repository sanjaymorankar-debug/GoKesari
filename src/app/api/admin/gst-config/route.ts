/**
 * GST rules as dated data (Module 2). Admin only.
 *   GET → every rule row (current and past) and what each key means.
 *   PUT { key, value, effectiveFrom, note? } → a value from a date (today or later).
 */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { GST_RULE_HELP, listGstRules, setGstRule, setRuleSchema } from "@/server/gst/config";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.GST_CONFIG_MANAGE);
  return ok({ rules: await listGstRules(), help: GST_RULE_HELP });
});

export const PUT = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.GST_CONFIG_MANAGE);
  return ok({ rule: await setGstRule(await parseBody(request, setRuleSchema), user) });
});
