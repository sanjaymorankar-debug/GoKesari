/**
 * Checkout's own checks, passed the way a customer passes them, so order checks keep working while the
 * test site has them on (docs/sms-2fa-2026-11, docs/identity-verification-2026-11):
 *
 *   - rule checkoutOtp → 403 { details.stepUp: "CHECKOUT_OTP", needsPhone }: send the code (to a fixed
 *     test mobile when the account has none), read it from the MOCK outbox with the admin session
 *     (GET /api/admin/test-messages), verify it;
 *   - identity_verification_customers_enabled → 409 { details.needsIdentityVerification }: verify with a
 *     mock PAN (consent ticked); a name-mismatch answer is approved by the admin, as a reviewer would.
 *
 * `call()` (http.ts) runs this for POST /api/checkout and sends the same body again. Never on
 * production: there the SMS and KYC providers are real. A check that wants the refusal itself passes
 * `{ rawCheckout: true }` to call().
 */
import type { APIRequestContext } from "@playwright/test";
import { createHash } from "node:crypto";

import { as } from "./actors";
import type { Answer } from "./http";
import { IS_PROD } from "./target";

type Send = () => Promise<Answer>;

function digits(seed: string, count: number, min = 0): string {
  const n = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 12), 16);
  return String(min + (n % (10 ** count - min))).padStart(count, "0");
}

async function userId(ctx: APIRequestContext, call: (c: APIRequestContext, m: "GET", p: string) => Promise<Answer>): Promise<string> {
  const res = await call(ctx, "GET", "/api/auth/session");
  return String(res.body?.user?.id ?? res.body?.user?.email ?? "qa");
}

/** The newest mock SMS code sent to a number ending in `last4` since `since` (ms), or null. */
async function mockCode(call: (c: APIRequestContext, m: "GET", p: string) => Promise<Answer>, last4: string, since: number): Promise<string | null> {
  const admin = await as("admin");
  for (let i = 0; i < 10; i++) {
    const res = await call(admin, "GET", `/api/admin/test-messages?to=${last4}`);
    const list = (res.body?.messages ?? []) as { body?: string; createdAt?: string }[];
    const hit = list.find((m) => !m.createdAt || new Date(m.createdAt).getTime() >= since - 5_000);
    const code = hit?.body?.match(/\b(\d{4,8})\b/)?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return null;
}

type Caller = (ctx: APIRequestContext, method: "GET" | "POST", path: string, data?: unknown, options?: { rawCheckout?: boolean }) => Promise<Answer>;

async function passSmsStep(ctx: APIRequestContext, call: Caller, details: { needsPhone?: boolean; maskedPhone?: string | null }): Promise<boolean> {
  // A fixed test mobile per account (mock provider only): 99999 + 5 digits of the user id.
  const mobile = details.needsPhone ? `99999${digits(await userId(ctx, call), 5)}` : null;
  const last4 = mobile ? mobile.slice(-4) : String(details.maskedPhone ?? "").replace(/\D/g, "").slice(-4);
  if (last4.length !== 4) return false;
  let since = Date.now();
  let sent = await call(ctx, "POST", "/api/checkout/otp", mobile ? { mobile } : {});
  // Back-to-back orders: the site makes a second code wait (RATE_LIMITED, retryAfterSeconds). Wait it out once.
  const wait = Number(sent.body?.error?.details?.retryAfterSeconds);
  if (sent.status === 429 && wait > 0 && wait <= 120) {
    await new Promise((r) => setTimeout(r, wait * 1000 + 1_000));
    since = Date.now();
    sent = await call(ctx, "POST", "/api/checkout/otp", mobile ? { mobile } : {});
  }
  if (sent.status >= 400) return false;
  const code = await mockCode(call, last4, since);
  if (!code) return false;
  const ok = await call(ctx, "POST", "/api/checkout/otp/verify", mobile ? { code, mobile } : { code });
  return ok.status === 200;
}

async function passIdentityCheck(ctx: APIRequestContext, call: Caller): Promise<boolean> {
  // Mock PAN: digits 6–9 pick the scenario on the mock (7777 / 0000 / 9999 are the failures), so stay in 1000–6999.
  const pan = `QAAPQ${digits(await userId(ctx, call), 4, 1000).replace(/^[7-9]/, "6")}Q`;
  const res = await call(ctx, "POST", "/api/account/identity/pan", { consent: true, pan });
  const v = res.body?.verification;
  if (v?.status === "VERIFIED") return true;
  if (v?.status === "NAME_MISMATCH_REVIEW" && v.id) {
    const decided = await call(await as("admin"), "POST", `/api/admin/identity-verifications/${v.id}/decision`, {
      decision: "APPROVE",
      note: "QA run: mock PAN in another name, approved so the order check can go on",
    });
    return decided.body?.verification?.status === "VERIFIED";
  }
  return false;
}

/**
 * When `answer` is checkout asking for its SMS code or the identity check, passes that step and sends
 * the checkout again (at most twice: the code, then identity, or the other way round).
 */
export async function passCheckoutChecks(ctx: APIRequestContext, call: Caller, answer: Answer, again: Send): Promise<Answer> {
  if (IS_PROD) return answer;
  let res = answer;
  for (let i = 0; i < 2; i++) {
    const d = res.body?.error?.details ?? {};
    let passed = false;
    if (res.status === 403 && d.stepUp === "CHECKOUT_OTP") passed = await passSmsStep(ctx, call, d);
    else if (res.status === 409 && d.needsIdentityVerification) passed = await passIdentityCheck(ctx, call);
    else return res;
    if (!passed) return res;
    res = await again();
  }
  return res;
}
