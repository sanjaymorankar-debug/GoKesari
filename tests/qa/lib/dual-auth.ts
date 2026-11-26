/**
 * Dual authentication (docs/dual-auth-2026-11, flag dual_auth, migration 0219: ON on test.gokesari.com, OFF on
 * gokesari.com). While it is in force (flag on AND an SMS provider), an account with only one verified factor is
 * refused orders, shop / dealer / admin work and withdrawals (403 "Please verify both your mobile number and your
 * e-mail to continue.", details.dualAuth = NEEDS_SECOND_FACTOR), and a staff account's pages send it to
 * /account/verify.
 *
 * The staging test accounts sign in with the emailed code, so their e-mail factor is verified; some have no
 * verified mobile (gk-oplim, gk-admin2: no number; the rider: a number never verified). Before an account's first
 * use in a worker, this completes the missing MOBILE factor the way a person does on /account/verify
 * (POST /api/dual-auth/verify mobile-code → the code from the MOCK SMS outbox, read with the admin session →
 * mobile-verify). An account without a number gets the same fixed test mobile the checkout SMS step gives it
 * (99999 + 5 digits of the user id, lib/checkout-checks.ts).
 *
 * Only with SMS_PROVIDER=mock (the outbox answers) and never on production. A missing e-mail factor needs the
 * emailed code (Gmail, skill gokesari-qa-signin): the account is then left as it is and its checks report the
 * site's refusal. Never throws: what it did is kept for the check's note (dualAuthNote).
 */
import type { APIRequestContext } from "@playwright/test";
import { createHash } from "node:crypto";

import { call, type Answer } from "./http";
import { IS_PROD } from "./target";

interface Status {
  mobileVerified?: boolean;
  emailVerified?: boolean;
  missing?: string[];
  maskedPhone?: string | null;
  inForce?: boolean;
}

const notes = new Map<string, string>();

/** What ensureDualVerified did for this account in this worker ("" when nothing was needed). */
export function dualAuthNote(key: string): string {
  return notes.get(key) ?? "";
}

function digits(seed: string, count: number): string {
  const n = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 12), 16);
  return String(n % 10 ** count).padStart(count, "0");
}

async function outboxCode(admin: APIRequestContext, last4: string, since: number): Promise<string | null> {
  for (let i = 0; i < 15; i++) {
    const res = await call(admin, "GET", `/api/admin/test-messages?to=${last4}`);
    const list = (res.body?.messages ?? []) as { body?: string; createdAt?: string }[];
    const hit = list.find((m) => !m.createdAt || new Date(m.createdAt).getTime() >= since - 5_000);
    const code = hit?.body?.match(/\b(\d{6})\b/)?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return null;
}

/**
 * Completes `key`'s missing mobile factor while dual_auth is in force. `admin` is the admin session that reads the
 * mock SMS outbox (null for the admin account itself, which is verified on the test site).
 */
export async function ensureDualVerified(key: string, ctx: APIRequestContext, admin: () => Promise<APIRequestContext | null>): Promise<string> {
  if (IS_PROD) return "";
  if (notes.has(key)) return notes.get(key)!;
  let note = "";
  try {
    const status = await call(ctx, "GET", "/api/dual-auth/status");
    const s = (status.body ?? {}) as Status;
    if (status.status !== 200 || !s.inForce || !(s.missing ?? []).length) {
      notes.set(key, "");
      return "";
    }
    if (!(s.missing ?? []).includes("MOBILE")) {
      note = `dual_auth: ${key}'s e-mail factor is not verified (needs the emailed code; skill gokesari-qa-signin)`;
      notes.set(key, note);
      return note;
    }
    const adminCtx = await admin();
    if (!adminCtx) {
      note = `dual_auth: no admin session to read ${key}'s SMS code`;
      notes.set(key, note);
      return note;
    }
    const session = await call(ctx, "GET", "/api/auth/session");
    const id = String(session.body?.user?.id ?? key);
    const mobile = s.maskedPhone ? null : `99999${digits(id, 5)}`;
    const last4 = mobile ? mobile.slice(-4) : String(s.maskedPhone).replace(/\D/g, "").slice(-4);
    let since = Date.now();
    let sent: Answer = await call(ctx, "POST", "/api/dual-auth/verify", mobile ? { action: "mobile-code", mobile } : { action: "mobile-code" });
    const wait = Number(sent.body?.error?.details?.retryAfterSeconds);
    if (sent.status === 429 && wait > 0 && wait <= 120) {
      await new Promise((r) => setTimeout(r, wait * 1000 + 1_000));
      since = Date.now();
      sent = await call(ctx, "POST", "/api/dual-auth/verify", mobile ? { action: "mobile-code", mobile } : { action: "mobile-code" });
    }
    if (sent.status !== 200) {
      note = `dual_auth: ${key}'s mobile code was not sent (HTTP ${sent.status} ${sent.body?.error?.message ?? ""})`;
    } else {
      const code = await outboxCode(adminCtx, last4, since);
      if (!code) note = `dual_auth: no SMS code for ${key} in the mock outbox (SMS_PROVIDER is not mock?)`;
      else {
        const done = await call(ctx, "POST", "/api/dual-auth/verify", mobile ? { action: "mobile-verify", mobile, code } : { action: "mobile-verify", code });
        note =
          done.status === 200 && !(done.body?.status?.missing ?? []).length
            ? `dual_auth: ${key}'s mobile verified (…${last4}) through /api/dual-auth/verify and the mock outbox`
            : `dual_auth: ${key}'s mobile not verified (HTTP ${done.status} ${done.body?.error?.message ?? ""})`;
      }
    }
  } catch (error) {
    note = `dual_auth: ${key} not verified (${error instanceof Error ? error.message : String(error)})`;
  }
  if (note) console.log(`[qa] ${note}`);
  notes.set(key, note);
  return note;
}

/**
 * A sensitive action (CONTACT_CHANGE, BANK_CHANGE, WITHDRAWAL, TEAM_ROLE: src/server/dual-auth/step-up.ts) asks for an
 * SMS code AND an e-mailed code while dual_auth is in force: the "Confirm it's you" dialog. Waits up to `timeoutMs`
 * for it; when it shows, checks it names both factors and blocks the case — the e-mailed code needs the inbox
 * (skill gokesari-qa-signin), which a run without Gmail cannot read. Returns quietly when no dialog came.
 */
export async function blockAtDualStepUp(page: import("@playwright/test").Page, what: string, timeoutMs = 15_000): Promise<void> {
  const dialog = page.getByTestId("dual-step-up");
  const shown = await dialog.waitFor({ state: "visible", timeout: timeoutMs }).then(() => true, () => false);
  if (!shown) return;
  const { expect } = await import("@playwright/test");
  await expect(dialog.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await expect(dialog).toContainText("a code from your mobile (SMS) and a code from your e-mail");
  await expect(dialog.getByTestId("dual-step-up-send")).toBeVisible();
  const { blocked } = await import("./record");
  blocked(`dual_auth: ${what} asks for both codes ("Confirm it's you": SMS + e-mail, shown as designed); the e-mailed code needs the test inbox (Gmail not authorised in this run)`);
}
