/**
 * Admin → Sign-in security (docs/sms-2fa-2026-11). ADMIN only — everyone else gets 403.
 *
 * GET → { provider, audiences, checkout, stats } (never any SMS key)
 * PUT { kind: "audience", audience: "customers" | "shopOwners", enabled, reason }
 *       → the SMS sign-in code switch, through setFeatureFlag (logged); with
 *         rbac_v2_four_eye_admin on, it waits for a second admin (202)
 * PUT { kind: "checkout", enabled, mode, hours } → rule checkoutOtp (audited)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { fourEyeAdminOn, requestFourEye, FOUR_EYE_TYPES } from "@/server/approvals";
import { SIGN_IN_AUDIENCES, setCheckoutCode, setSignInSmsCode, signInSecurityOverview } from "@/server/otp/sign-in-security";

export const dynamic = "force-dynamic";

const putSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("audience"),
    audience: z.enum(["customers", "shopOwners"]),
    enabled: z.boolean(),
    reason: z.string().max(500),
  }),
  z.object({
    kind: z.literal("checkout"),
    enabled: z.boolean(),
    mode: z.enum(["every_checkout", "once_per_hours"]),
    hours: z.number().int().min(1).max(720),
  }),
]);

export const GET = route(async () => {
  await requireRole("ADMIN");
  return ok(await signInSecurityOverview());
});

export const PUT = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, putSchema);
  if (body.kind === "checkout") {
    const rule = await setCheckoutCode({ enabled: body.enabled, mode: body.mode, hours: body.hours }, admin);
    return ok({ checkout: rule });
  }
  if (body.reason.trim().length < 5) {
    throw validationFailed("Say why you are changing this switch.", { fields: { reason: "Give a reason (at least 5 characters)." } });
  }
  const flag = SIGN_IN_AUDIENCES[body.audience].flag;
  // Same as the feature-flags page: with four-eye on, a second admin approves the switch first.
  if (await fourEyeAdminOn()) {
    return ok(
      await requestFourEye(FOUR_EYE_TYPES.FEATURE_FLAG_SET, admin, {
        subjectType: "feature_flag",
        subjectId: flag,
        title: `${body.enabled ? "Switch on" : "Switch off"} ${flag}`,
        reason: body.reason,
        payload: { key: flag, enabled: body.enabled, districtCodes: null },
      }),
      202,
    );
  }
  const result = await setSignInSmsCode(body.audience, body.enabled, body.reason, admin);
  return ok({ ...result, pendingApproval: false });
});
