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
import { listRules, resetRule, setRule } from "@/server/services/settings";

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
  return ok({ key: body.key, value: await setRule(body.key as RuleKey, body.value, admin) });
});

export const DELETE = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const key = new URL(request.url).searchParams.get("key");
  if (!key || !(key in RULES)) throw validationFailed("Unknown setting.");
  await resetRule(key as RuleKey, admin);
  return ok({ key, reset: true });
});
