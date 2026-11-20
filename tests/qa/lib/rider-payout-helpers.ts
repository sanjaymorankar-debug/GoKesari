/**
 * Helpers for the rider KYC (DigiLocker) and rider bank payout checks
 * (docs/gig-worker-2026-10, docs/gig-bank-payouts-2026-10):
 * tests/qa/local/orders-rider-digilocker.spec.ts,
 * tests/qa/local/finance-rider-payouts.spec.ts,
 * tests/qa/signed-in/finance-rider-payouts.spec.ts and
 * tests/qa/scenarios/SC-40-rider-kyc-payout.spec.ts.
 *
 * Local-only helpers (they create accounts, read the local mail catcher or
 * arrange rows with db()) say so and block elsewhere. Nothing here sends a real
 * bank account or a real Aadhaar: the bank details are Cashfree's sandbox test
 * account (docs/testing/cashfree-sandbox-test-data.md) and Aadhaar comes from
 * the DigiLocker mock (/mobile-auth/digilocker-mock).
 */
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { createHmac, hkdfSync, randomInt } from "node:crypto";

import { as } from "./actors";
import { browserWithCookie, localUser, type LocalUser } from "./auth-helpers";
import { db } from "./db";
import { call, expectStatus, RUN, type Answer } from "./http";
import { mailsTo } from "./money-helpers";
import { png, upload } from "./orders-helpers";
import { blocked, need } from "./record";
import { assertWritable, IS_LOCAL } from "./target";
import { world } from "./world";

/* ------------------------------------------------------------ flags */

export const RIDER_FLAGS = ["rider_bank_account_enabled", "rider_withdrawal_enabled", "rider_monthly_payout_enabled"] as const;
export type RiderFlag = (typeof RIDER_FLAGS)[number];

interface FlagRow {
  key: string;
  enabled: boolean;
  districtCodes: string[] | null;
}

/** Every feature flag as Admin → Feature flags has it (admin session). */
export async function flagRows(): Promise<FlagRow[]> {
  const res = await call(await as("admin"), "GET", "/api/admin/feature-flags");
  if (res.status === 401 || res.status === 403) blocked(`the admin session cannot read the feature flags (HTTP ${res.status})`);
  expectStatus(res, 200, "GET /api/admin/feature-flags");
  return res.body.flags as FlagRow[];
}

/** Whether each rider payout flag is on (on anywhere: a flag limited to districts counts as on). */
export async function riderFlags(): Promise<Record<RiderFlag, boolean>> {
  const rows = await flagRows();
  const on = (key: RiderFlag) => Boolean(rows.find((r) => r.key === key)?.enabled);
  return { rider_bank_account_enabled: on("rider_bank_account_enabled"), rider_withdrawal_enabled: on("rider_withdrawal_enabled"), rider_monthly_payout_enabled: on("rider_monthly_payout_enabled") };
}

/** Blocks the check unless every flag of `keys` is on on this site (staging: the flags are read, never changed). */
export async function needFlagsOn(keys: readonly RiderFlag[]) {
  const flags = await riderFlags();
  const off = keys.filter((k) => !flags[k]);
  if (off.length) blocked(`flag ${off.join(" and ")} is off on this site (the case is Not Applicable while it is off)`);
  return flags;
}

/**
 * Local only: switches feature flags through Admin → Feature flags (so the
 * server's flag cache is cleared at once) and returns the function that puts
 * every one back as it was.
 */
export async function setFlags(changes: Partial<Record<RiderFlag, boolean>>): Promise<() => Promise<void>> {
  if (!IS_LOCAL) blocked("switching feature flags is for the local server only");
  assertWritable("switch feature flags");
  const admin = await as("admin");
  const before = await flagRows();
  const changed: FlagRow[] = [];
  const put = (key: string, enabled: boolean, districtCodes: string[] | null, reason: string) =>
    call(admin, "PUT", "/api/admin/feature-flags", { key, enabled, districtCodes, reason });
  const restore = async () => {
    for (const row of changed.reverse()) {
      expectStatus(await put(row.key, row.enabled, row.districtCodes, `QA local run ${RUN}: put back after the rider payout checks`), 200, `restore flag ${row.key}`);
    }
  };
  try {
    for (const [key, enabled] of Object.entries(changes) as [RiderFlag, boolean][]) {
      const row = before.find((r) => r.key === key) ?? { key, enabled: false, districtCodes: null };
      if (row.enabled === enabled && row.districtCodes === null) continue;
      changed.push(row);
      expectStatus(await put(key, enabled, null, `QA local run ${RUN}: rider payout checks`), 200, `switch flag ${key} ${enabled ? "on" : "off"}`);
    }
  } catch (error) {
    await restore();
    throw error;
  }
  return restore;
}

/** Runs `body` with the flags switched, and always puts them back. Local only. */
export async function withFlags<T>(changes: Partial<Record<RiderFlag, boolean>>, body: () => Promise<T>): Promise<T> {
  const restore = await setFlags(changes);
  try {
    return await body();
  } finally {
    await restore();
  }
}

export const ALL_RIDER_FLAGS_ON: Partial<Record<RiderFlag, boolean>> = {
  rider_bank_account_enabled: true,
  rider_withdrawal_enabled: true,
  rider_monthly_payout_enabled: true,
};

/* ------------------------------------------------------------ riders */

/** Letters only (names and labels are checked as names). */
const letters = (s: string) => s.replace(/\d/g, (d) => "abcdefghij"[Number(d)]).replace(/[^a-z]/gi, "");
export const RUN_TAG = letters(RUN);

/** An individual's PAN whose four digits never pick a mock outcome (…0000, …9999, …8888, …7777, …5555). */
export function riderPan(): string {
  const L = "ABCDEFGHJKLMNPRSTUVWXYZ";
  const pick = () => L[randomInt(0, L.length)];
  return `${pick()}${pick()}${pick()}P${pick()}1${String(randomInt(100, 999))}${pick()}`;
}

export interface Rider extends LocalUser {
  partnerId: string;
  name: string;
  pan: string | null;
}

/**
 * Local only: a new account that has applied as a delivery partner with every
 * detail the registration form asks for (status REGISTERED). `pan`: the PAN is
 * given at registration (stored encrypted), so TDS is worked out "with PAN".
 */
export async function applicant(label: string, options: { pan?: boolean } = {}): Promise<Rider> {
  if (!IS_LOCAL) blocked("a new delivery partner is created on the local server only");
  const name = `QA Rider ${letters(label)} ${RUN_TAG}`;
  const user = await localUser(`rider-${label}`, { name });
  const home = world().location ?? { pincode: "411038", lat: 18.5074, lng: 73.8077 };
  const pan = options.pan === false ? null : riderPan();
  const res = await call(user.ctx, "POST", "/api/delivery-partner", {
    fullName: name,
    mobile: need(user.mobile, "a mobile number on the new account"),
    email: user.email,
    dateOfBirth: "1994-06-15",
    gender: "MALE",
    addressLine: "Flat 12, QA Residency, Baner Road",
    addressCity: "Pune",
    addressPincode: "411045",
    vehicleType: "SCOOTER",
    vehicleRegistrationNumber: "MH12AB1234",
    emergencyContactName: "QA Emergency Contact",
    emergencyContactMobile: "9822000111",
    latitude: home.lat + 0.002,
    longitude: home.lng + 0.002,
    operatingRadiusKm: 5,
    ...(pan ? { panNumber: pan } : {}),
  });
  expectStatus(res, 201, "delivery partner application");
  return { ...user, partnerId: String(res.body.id), name, pan };
}

/** Local only: an identity document on file and the application approved by operations (D-57). */
export async function approve(rider: Rider) {
  const doc = await upload(rider.ctx, "/api/delivery-partner/me/documents", { name: "licence.png", mimeType: "image/png", buffer: png(400, 260) }, { docType: "DRIVING_LICENCE" });
  expectStatus(doc, 201, "upload an identity document");
  expectStatus(await call(await as("ops"), "PATCH", `/api/delivery-partner/${rider.partnerId}`, { action: "approve" }), 200, "operations approves the rider");
}

export async function approvedRider(label: string, options: { pan?: boolean } = {}): Promise<Rider> {
  const rider = await applicant(label, options);
  await approve(rider);
  return rider;
}

/** A browser page signed in as `user` (close the context when done). */
export async function pageOf(browser: Browser, user: Pick<LocalUser, "cookie">, options: Parameters<Browser["newContext"]>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  return browserWithCookie(browser, user.cookie, options);
}

/* ------------------------------------------------------- bank account */

/** Cashfree's sandbox test bank account (docs/testing/cashfree-sandbox-test-data.md, TPV table): never a real account. */
export const TEST_BANK = { accountNumber: "1111222233", ifsc: "TEST0001234" } as const;
/** Cashfree's sample account for its Verification Suite sandbox (bank-account-check.ts SANDBOX_SAMPLE_ACCOUNT; TEST_CHECKLIST O7.3). */
export const SECURE_ID_SAMPLE = { accountNumber: "026291800001191", ifsc: "YESB0000262", name: "John Doe" } as const;

export async function saveBankAccount(ctx: APIRequestContext, holder: string, account: { accountNumber: string; ifsc: string } = TEST_BANK): Promise<Answer> {
  assertWritable("save a bank account");
  return call(ctx, "PUT", "/api/bank-account", { method: "BANK_ACCOUNT", accountHolderName: holder, accountNumber: account.accountNumber, confirmAccountNumber: account.accountNumber, ifsc: account.ifsc });
}

/**
 * Local only: the rider's own bank account saved and verified with the ₹1
 * check on the test gateway (the simulator every site without gateway keys
 * offers), exactly as the rider would on My wallet.
 */
export async function verifiedAccount(rider: Rider, account: { accountNumber: string; ifsc: string } = TEST_BANK): Promise<string> {
  const saved = await saveBankAccount(rider.ctx, rider.name, account);
  expectStatus(saved, 200, "save the rider's bank account");
  const accountId = String(saved.body.id);
  const start = await call(rider.ctx, "POST", "/api/bank-account/verification", { accountId });
  expectStatus(start, 201, "start the ₹1 check");
  if (start.body.mode !== "SIMULATOR") blocked(`the ₹1 check runs on ${start.body.mode} here, not the test simulator`);
  const done = await call(rider.ctx, "POST", "/api/bank-account/verification/simulate", { gatewayOrderId: start.body.gatewayOrderId, method: "UPI", outcome: "SUCCESS" });
  expectStatus(done, 200, "pay the ₹1 on the test gateway");
  if (done.body.status !== "VERIFIED") throw new Error(`the ₹1 check did not verify the account: ${JSON.stringify(done.body).slice(0, 300)}`);
  return accountId;
}

/* ------------------------------------------------------------ money */

/**
 * Local only: unpaid earnings for the rider, as finished deliveries leave them
 * (one delivery_partner_earnings row per amount, at `at`). Deliveries
 * themselves are covered by the rider earnings and journey specs.
 */
export async function arrangeEarnings(partnerId: string, totalsPaise: number[], at: Date = new Date()) {
  for (const total of totalsPaise) {
    await db()`insert into delivery_partner_earnings (delivery_partner_id, base_paise, distance_paise, total_paise, created_at)
      values (${partnerId}, ${total}, 0, ${total}, ${at})`;
  }
}

/** Local only: payments the rider already received this financial year (a paid weekly payout of `amountPaise`). */
export async function arrangePaidThisYear(partnerId: string, amountPaise: number) {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  await db()`insert into rider_payouts (delivery_partner_id, period_start, period_end, earnings_count, gross_paise, adjustments_paise, amount_paise, status, paid_at, payment_reference)
    values (${partnerId}, ${today}, ${today}, 1, ${amountPaise}, 0, ${amountPaise}, 'PAID', now(), ${`QA-${RUN}`})`;
}

/**
 * Local only: a past month (YYYY-MM) no monthly run has used yet. Old enough
 * that nobody else has unpaid earnings from before its end, so a "Run now" of
 * it pays exactly the riders a check arranged.
 */
export async function unusedPastMonth(): Promise<{ month: string; inside: Date }> {
  const used = new Set((await db()<{ period_month: string }[]>`select period_month from rider_payout_runs`).map((r) => r.period_month));
  for (let i = 0; i < 500; i++) {
    const month = `${randomInt(1990, 2020)}-${String(randomInt(1, 13)).padStart(2, "0")}`;
    if (!used.has(month)) return { month, inside: new Date(`${month}-15T12:00:00+05:30`) };
  }
  blocked("no unused past month left for a monthly run");
}

export interface TransferRow {
  id: string;
  kind: string;
  status: string;
  mode: string;
  gross_paise: number;
  tds_paise: number;
  tds_rate_bp: number;
  fee_paise: number;
  net_paise: number;
  retry_count: number;
  attempts: number;
  needs_review: boolean;
  next_retry_at: Date | null;
  updated_at: Date;
  failure_reason: string | null;
  run_id: string | null;
}

/** Local only: the rider's bank transfers, newest first. */
export async function transfersOf(partnerId: string): Promise<TransferRow[]> {
  return db()<TransferRow[]>`select id, kind, status, mode, gross_paise::int as gross_paise, tds_paise::int as tds_paise, tds_rate_bp, fee_paise::int as fee_paise,
    net_paise::int as net_paise, retry_count, attempts, needs_review, next_retry_at, updated_at, failure_reason, run_id
    from rider_bank_transfers where delivery_partner_id = ${partnerId} order by created_at desc`;
}

/** Local only: in-app notifications to `userId` since `since`, newest first. */
export async function notificationsTo(userId: string, since: Date) {
  return db()<{ title: string; body: string; action_url: string | null }[]>`select title, body, action_url from notifications
    where user_id = ${userId} and created_at >= ${new Date(since.getTime() - 2000)} order by created_at desc`;
}

/* ------------------------------------------------------- e-mailed codes */

/** Local only: moves the account's codes of `purpose` back past the 60 s resend cooldown (a person waiting a minute). */
export async function ageActionCodes(email: string, purpose: "RIDER_WITHDRAWAL" | "RIDER_BANK_CHANGE") {
  await db()`update login_otps set created_at = created_at - interval '61 seconds' where email = ${email.toLowerCase()} and purpose = ${purpose}`;
}

/**
 * Local only: the code of the newest "<code> — confirm … on GoKesari" e-mail
 * (withdrawal or bank-account change) to `email` since `since`.
 */
const handedOut = new Set<string>();

export async function actionCode(email: string, since: number, timeoutMs = 20_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // Newest first; a code already handed out is an earlier e-mail still inside the 1 s slack: wait for the new one.
    for (const mail of mailsTo(email, since - 1000)) {
      const code = mail.subject.match(/^(\d{4,8}) — confirm /)?.[1] ?? mail.text.match(/Your code:\s*(\d{4,8})/)?.[1];
      if (code && !handedOut.has(`${email}|${code}`)) {
        handedOut.add(`${email}|${code}`);
        return code;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  blocked(`no confirmation code reached the local mail catcher for ${email} within ${timeoutMs / 1000} s`);
}

/** Local only: asks for a withdrawal code (after the cooldown) and returns it. */
export async function withdrawalCode(rider: Rider, amountPaise: number): Promise<string> {
  await ageActionCodes(rider.email, "RIDER_WITHDRAWAL");
  const since = Date.now();
  const sent = await call(rider.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise });
  expectStatus(sent, 200, "ask for a withdrawal code");
  return actionCode(rider.email, since);
}

/** Local only: a withdrawal confirmed with a fresh e-mailed code (the API the Withdraw button calls). */
export async function withdraw(rider: Rider, amountPaise: number): Promise<Answer> {
  const code = await withdrawalCode(rider, amountPaise);
  return call(rider.ctx, "POST", "/api/gig/wallet/withdrawals", { amountPaise, code });
}

/** What a withdrawal of `amountPaise` would pay (GET /api/gig/wallet/quote). */
export async function quote(ctx: APIRequestContext, amountPaise: number) {
  const res = await call(ctx, "GET", `/api/gig/wallet/quote?amountPaise=${amountPaise}`);
  expectStatus(res, 200, `quote ₹${amountPaise / 100}`);
  return res.body as { amountPaise: number; feePaise: number; tdsPaise: number; tdsRateBp: number; netPaise: number; problem: string | null };
}

/* ------------------------------------------------------------ DigiLocker */

/** Local only: the partner's PAN or Aadhaar check row. */
export async function kycRow(partnerId: string, docType: "PAN" | "AADHAAR") {
  const [row] = await db()<
    { id: string; status: string; number_masked: string; number_token: string; number_encrypted: string | null; name_on_record: string | null; error_code: string | null; session_id: string | null; method: string | null }[]
  >`select id, status, number_masked, number_token, number_encrypted, name_on_record, error_code, session_id, method
    from delivery_partner_kyc_checks where delivery_partner_id = ${partnerId} and doc_type = ${docType}`;
  return row ?? null;
}

/** "Verify with DigiLocker" through the API: the link to open and the mock session in it. */
export async function startDigilocker(rider: Pick<Rider, "ctx">): Promise<{ url: string; session: string | null; res: Answer }> {
  const res = await call(rider.ctx, "POST", "/api/delivery-partner/me/kyc/aadhaar/digilocker", { consent: true });
  expectStatus(res, 200, "start DigiLocker");
  const url = need(res.body?.url as string | null, "a DigiLocker link");
  return { url, session: new URL(url).searchParams.get("session"), res };
}

/** The mock consent page's choice, then DigiLocker's return link followed once: where it sends the partner. */
export async function decideMock(rider: Pick<Rider, "ctx">, session: string, decision: "approve" | "mismatch" | "deny" | "expire" | "down") {
  const chosen = await call(rider.ctx, "POST", "/api/kyc-mock/digilocker", { session, decision });
  expectStatus(chosen, 200, `mock DigiLocker: ${decision}`);
  const back = new URL(chosen.body.redirectUrl as string);
  const ret = await call(rider.ctx, "GET", back.pathname + back.search);
  return { status: ret.status, location: ret.location ?? "" };
}

/** The holder id the DigiLocker mock "signs in" as for a session (adapters/mock.ts: one DigiLocker account per session). */
export function mockHolderOf(session: string) {
  return `mock-holder-${session.slice(-12)}`;
}

/**
 * Local only: the keyed token the server stores for a document number
 * (lib/pan-crypto.ts docBlindIndex), from the local server's
 * PAN_ENCRYPTION_KEY — used to arrange "the same DigiLocker account" on two partners.
 */
export function blindIndex(docType: string, value: string): string {
  const raw = need(process.env.PAN_ENCRYPTION_KEY, "PAN_ENCRYPTION_KEY (the local server's)");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) blocked("PAN_ENCRYPTION_KEY does not decode to 32 bytes");
  const subKey = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "gokesari:seller-doc-blind-index:v1", 32));
  return createHmac("sha256", subKey).update(`${docType}:${value}`, "utf8").digest("hex");
}

/** Local only: rule riderVerification set for DigiLocker through the mock (restore with the returned function). */
export async function digilockerMockRule(): Promise<() => Promise<void>> {
  const { setRules } = await import("./finance-helpers");
  return setRules({ riderVerification: { aadhaarMethod: "digilocker", digilockerProvider: "mock" } });
}
