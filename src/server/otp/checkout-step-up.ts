/**
 * docs/sms-2fa-2026-11 (3b): checkout step-up — a fresh SMS code before an
 * order is placed (rule checkoutOtp, default off).
 *
 *   every_checkout  a verified CHECKOUT code is a pass for ONE order, good for
 *                   CHECKOUT_PASS_MINUTES; placing the order spends it
 *                   (login_otps.step_up_request_id = the checkout request id,
 *                   so a retry of the same request is not asked again);
 *   once_per_hours  a code verified in the last `hours` hours covers every order.
 *
 * Enforced on the server in POST /api/checkout (claimCheckoutStepUp), before
 * the wallet / COD / online checkout runs. The code goes to the account's
 * verified mobile; an account without one gives its number in the same step
 * and it is saved as verified. Rule off, or SMS codes not available on this
 * server → nothing is asked and orders are placed as before.
 */
import { and, desc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";

import { AppError } from "@/lib/errors";
import { maskPhone } from "@/lib/phone";
import { db } from "@/server/db";
import { loginOtps, users, type User } from "@/server/db/schema";
import type { RuleValue } from "@/server/config/rules";
import { getRule } from "@/server/services/settings";
import { consumeSmsCode, hasVerifiedPhone, markPhoneVerified, resolveSmsTarget, sendSmsCode, smsCodesAvailable } from "./second-factor";

/** every_checkout: how long a verified code stays usable for its one order. */
export const CHECKOUT_PASS_MINUTES = 10;
export const CHECKOUT_OTP_REQUIRED = "Confirm this order with the code we send to your mobile by SMS.";

type Rule = RuleValue<"checkoutOtp">;

/** The rule, when the step-up is really in force on this server (rule on AND SMS codes available). */
export async function activeCheckoutOtpRule(): Promise<Rule | null> {
  const rule = await getRule("checkoutOtp");
  if (!rule.enabled) return null;
  if (!(await smsCodesAvailable())) {
    console.warn("[checkout-otp] rule checkoutOtp is on but SMS codes are not available here: orders are placed without the code.");
    return null;
  }
  return rule;
}

async function loadUser(userId: string): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new AppError("UNAUTHENTICATED", "Please sign in to continue.");
  return user;
}

/** The newest verified CHECKOUT code still usable as a pass for `requestId` (or for any new request). */
async function findPass(userId: string, rule: Rule, requestId: string | null) {
  const now = Date.now();
  const verified = and(eq(loginOtps.userId, userId), eq(loginOtps.purpose, "CHECKOUT"), isNotNull(loginOtps.consumedAt));
  if (rule.mode === "once_per_hours") {
    const [row] = await db
      .select()
      .from(loginOtps)
      .where(and(verified, gt(loginOtps.consumedAt, new Date(now - rule.hours * 3_600_000))))
      .orderBy(desc(loginOtps.consumedAt))
      .limit(1);
    return row ?? null;
  }
  if (requestId) {
    // A retry of a request that already used its pass (the order may already exist).
    const [same] = await db.select().from(loginOtps).where(and(verified, eq(loginOtps.stepUpRequestId, requestId))).limit(1);
    if (same) return same;
  }
  const [fresh] = await db
    .select()
    .from(loginOtps)
    .where(and(verified, isNull(loginOtps.stepUpRequestId), gt(loginOtps.consumedAt, new Date(now - CHECKOUT_PASS_MINUTES * 60_000))))
    .orderBy(desc(loginOtps.consumedAt))
    .limit(1);
  return fresh ?? null;
}

export interface CheckoutStepUpState {
  /** The step-up is in force on this server. */
  required: boolean;
  /** A verified code already covers the next order. */
  satisfied: boolean;
  mode: "every_checkout" | "once_per_hours" | null;
  hours: number | null;
  needsPhone: boolean;
  maskedPhone: string | null;
}

export async function checkoutStepUpState(userId: string): Promise<CheckoutStepUpState> {
  const rule = await activeCheckoutOtpRule();
  if (!rule) return { required: false, satisfied: true, mode: null, hours: null, needsPhone: false, maskedPhone: null };
  const user = await loadUser(userId);
  const pass = await findPass(userId, rule, null);
  return {
    required: true,
    satisfied: Boolean(pass),
    mode: rule.mode,
    hours: rule.mode === "once_per_hours" ? rule.hours : null,
    needsPhone: !hasVerifiedPhone(user),
    maskedPhone: hasVerifiedPhone(user) ? maskPhone(user.phoneE164) : null,
  };
}

function stepUpRequired(state: { needsPhone: boolean; maskedPhone: string | null; mode: string }): AppError {
  return new AppError("FORBIDDEN", CHECKOUT_OTP_REQUIRED, { stepUp: "CHECKOUT_OTP", ...state });
}

/** Sends a checkout code by SMS. `mobile` only when the account has no verified mobile. */
export async function requestCheckoutOtp(input: { userId: string; mobile?: string | null; ip?: string | null }) {
  const rule = await activeCheckoutOtpRule();
  if (!rule) throw new AppError("CONFLICT", "No checkout code is needed on this site right now.");
  const user = await loadUser(input.userId);
  const target = await resolveSmsTarget(user, input.mobile);
  return sendSmsCode(user, target, "CHECKOUT", input.ip ?? null);
}

/** Verifies a checkout code; the number becomes the account's verified mobile. */
export async function verifyCheckoutOtp(input: { userId: string; code: string; mobile?: string | null; ip?: string | null }) {
  const rule = await activeCheckoutOtpRule();
  if (!rule) throw new AppError("CONFLICT", "No checkout code is needed on this site right now.");
  const user = await loadUser(input.userId);
  const target = await resolveSmsTarget(user, input.mobile);
  const otp = await consumeSmsCode(user, target, "CHECKOUT", input.code, input.ip ?? null);
  await markPhoneVerified(user, target);
  const validForMs = rule.mode === "once_per_hours" ? rule.hours * 3_600_000 : CHECKOUT_PASS_MINUTES * 60_000;
  return { mode: rule.mode, validUntil: new Date((otp.consumedAt ?? new Date()).getTime() + validForMs) };
}

/**
 * Called by POST /api/checkout before the order is placed. Throws FORBIDDEN
 * with details { stepUp: "CHECKOUT_OTP", needsPhone, maskedPhone, mode } when
 * no verified code covers this order. For every_checkout the pass is spent on
 * this request; `release` gives it back when the checkout then fails.
 */
export async function claimCheckoutStepUp(userId: string, requestId: string): Promise<{ release: () => Promise<void> }> {
  const none = { release: async () => {} };
  const rule = await activeCheckoutOtpRule();
  if (!rule) return none;
  const pass = await findPass(userId, rule, requestId);
  const refuse = async () => {
    const user = await loadUser(userId);
    return stepUpRequired({
      needsPhone: !hasVerifiedPhone(user),
      maskedPhone: hasVerifiedPhone(user) ? maskPhone(user.phoneE164) : null,
      mode: rule.mode,
    });
  };
  if (!pass) throw await refuse();
  if (rule.mode === "once_per_hours" || pass.stepUpRequestId === requestId) return none;

  // Spend it: only one checkout request can take an unused pass.
  const [spent] = await db
    .update(loginOtps)
    .set({ stepUpRequestId: requestId })
    .where(and(eq(loginOtps.id, pass.id), or(isNull(loginOtps.stepUpRequestId), eq(loginOtps.stepUpRequestId, requestId))))
    .returning({ id: loginOtps.id });
  if (!spent) throw await refuse();
  return {
    release: async () => {
      await db
        .update(loginOtps)
        .set({ stepUpRequestId: null })
        .where(and(eq(loginOtps.id, pass.id), eq(loginOtps.stepUpRequestId, requestId)));
    },
  };
}
