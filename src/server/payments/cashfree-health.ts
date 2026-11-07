/**
 * Admin → Payments → Cashfree (docs/payments-cashfree-audit-2026-11).
 *
 *  - cashfreeHealth: how Cashfree is set up on THIS site — environment and
 *    base URL per product (payments, payouts, Secure ID), whether the keys
 *    look like sandbox or production keys (never their values), the URLs sent
 *    to Cashfree, and anything unsafe (sandbox on gokesari.com, production on
 *    the test site, http URLs). With `live`, it also asks Cashfree, with this
 *    site's own keys: are the keys accepted, and which payment methods are
 *    switched on for the account (Get Eligible Payment Methods).
 *  - startCashfreeLiveTest / finishCashfreeLiveTest: a ₹1 test order the
 *    admin pays with any method in Cashfree's own checkout; "finish" reads the
 *    result from Cashfree and refunds the ₹1 at once. On the test site it runs
 *    against the sandbox (test cards / UPI), on gokesari.com it is a real ₹1
 *    that comes straight back. Every test is kept in the audit log.
 *
 * Nothing here changes an order, a wallet or a shop. Secrets never leave the server.
 */
import { randomBytes } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";

import {
  cashfreeApiBase,
  cashfreeEnvProblem,
  cashfreeKeyKind,
  cashfreeRefundSpeed,
  deployedSiteKind,
  findCashfreeVerificationKeys,
  getEnv,
  isPaymentGatewayLive,
} from "@/lib/env";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { auditLogs, users, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";
import { assertCashfreeEnvSafe, cashfreeNotifyUrl, cashfreeOrderExpiry } from "./cashfree-env";
import { paymentBaseUrl, webhookUrlFor } from "./gateway/common";

export const CASHFREE_PG_API_VERSION = "2023-08-01";
/** Get Eligible Payment Methods is asked with these versions in turn (the first one Cashfree accepts wins). */
const ELIGIBILITY_API_VERSIONS = ["2025-01-01", "2023-08-01"] as const;
/** ₹1 for a payment test; ₹2 when the test is of a partial refund (₹1 back, then the other ₹1). */
const LIVE_TEST_AMOUNTS_PAISE = [100, 200] as const;
const LIVE_TEST_PREFIX = "gktest_";

interface Actor {
  id: string;
  role: UserRole;
}

function assertFinanceView(actor: Actor): void {
  if (!can(actor.role, PERMISSIONS.FINANCE_VIEW)) throw forbidden();
}
function assertFinanceManage(actor: Actor): void {
  if (!can(actor.role, PERMISSIONS.FINANCE_MANAGE)) throw forbidden();
}

function pgHeaders(version: string = CASHFREE_PG_API_VERSION): Record<string, string> {
  const env = getEnv();
  return {
    "Content-Type": "application/json",
    "x-api-version": version,
    "x-client-id": env.CASHFREE_APP_ID ?? "",
    "x-client-secret": env.CASHFREE_SECRET_KEY ?? "",
  };
}

function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export interface EligibleMethod {
  method: string;
  eligible: boolean;
  /** Sub-options Cashfree lists (wallet / bank names), when it does. */
  options: string[];
}

export interface EligibilityResult {
  httpStatus: number | null;
  apiVersion: string | null;
  methods: EligibleMethod[];
  error: string | null;
}

export interface CashfreeHealthReport {
  checkedAt: string;
  site: { kind: "production" | "test" | "local"; host: string | null; publicBaseUrl: string };
  problems: string[];
  pg: {
    configured: boolean;
    env: "sandbox" | "production";
    apiBase: string;
    apiVersion: string;
    keyKind: "sandbox" | "production" | "unknown";
    /** PAYMENT_GATEWAY: which gateway takes online ORDER payments (top-ups, the registration fee and the ₹1 check always use Cashfree when its keys are set). */
    orderGateway: string;
    webhookSecret: "PAYMENT_WEBHOOK_SECRET_CASHFREE" | "CASHFREE_SECRET_KEY" | "none";
    refundSpeed: "STANDARD" | "INSTANT";
    checkoutScript: string;
  };
  urls: {
    /** Sent as notify_url with top-up and registration orders (Cashfree needs https). */
    topUpAndRegistrationWebhook: string | null;
    /** Sent as notify_url with order / registration-fee payment intents. */
    orderWebhook: string;
    payoutWebhook: string;
    /** Register these in the Cashfree dashboard (Developers → Webhooks), payment + refund events. */
    registerInDashboard: string[];
  };
  payouts: { configured: boolean; env: "sandbox" | "production"; provider: string; apiBase: string; problem: string | null };
  verification: { configured: boolean; env: "sandbox" | "production"; apiBase: string; twoFactor: "SIGNATURE" | "IP_WHITELIST" | null; problem: string | null };
  rules: { onlinePaymentsEnabled: boolean; onlinePaymentMethods: string[]; shopWalletEnabled: boolean; selfRegistrationEnabled: boolean };
  /** Only Cashfree's dashboard can show these; the owner ticks them off. */
  dashboardChecks: string[];
  live: null | {
    /** 404 on a made-up order id = the keys work; 401 = wrong keys for this environment. */
    keysAccepted: boolean | null;
    keysHttpStatus: number | null;
    /** Cashfree's x-deprecated-at header for our API version, when it sends one. */
    apiVersionDeprecatedAt: string | null;
    eligibility: EligibilityResult;
  };
}

async function askCashfreeKeys(): Promise<{ keysAccepted: boolean | null; keysHttpStatus: number | null; apiVersionDeprecatedAt: string | null }> {
  try {
    const response = await fetch(`${cashfreeApiBase()}/orders/${LIVE_TEST_PREFIX}health_probe_${Date.now()}`, {
      method: "GET",
      headers: pgHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    await response.text().catch(() => "");
    const accepted = response.status === 404 || response.ok ? true : response.status === 401 || response.status === 403 ? false : null;
    return { keysAccepted: accepted, keysHttpStatus: response.status, apiVersionDeprecatedAt: response.headers.get("x-deprecated-at") };
  } catch {
    return { keysAccepted: null, keysHttpStatus: null, apiVersionDeprecatedAt: null };
  }
}

/** Get Eligible Payment Methods (POST /pg/eligibility/payment_methods) for a ₹`amountRupees` payment. */
export async function fetchEligiblePaymentMethods(amountRupees = 1): Promise<EligibilityResult> {
  let last: EligibilityResult = {
    httpStatus: null,
    apiVersion: null,
    methods: [],
    error: "Not asked.",
  };
  for (const version of ELIGIBILITY_API_VERSIONS) {
    try {
      const response = await fetch(`${cashfreeApiBase()}/eligibility/payment_methods`, {
        method: "POST",
        headers: pgHeaders(version),
        body: JSON.stringify({ queries: { amount: amountRupees } }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      if (!response.ok) {
        last = { httpStatus: response.status, apiVersion: version, methods: [], error: text.slice(0, 300) };
        if (response.status === 401 || response.status === 403) return last;
        continue;
      }
      const body = JSON.parse(text) as unknown;
      const list = Array.isArray(body) ? body : [];
      const methods: EligibleMethod[] = list.map((entry: Record<string, unknown>) => {
        const details = (entry.entity_details as { payment_method_details?: { display?: string; nick?: string; eligibility?: boolean }[] } | undefined)?.payment_method_details ?? [];
        return {
          method: String(entry.entity_value ?? "?"),
          eligible: entry.eligibility === true,
          options: details.filter((d) => d.eligibility !== false).map((d) => d.display ?? d.nick ?? "?").slice(0, 40),
        };
      });
      return { httpStatus: response.status, apiVersion: version, methods, error: null };
    } catch (error) {
      last = { httpStatus: null, apiVersion: version, methods: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
  return last;
}

export async function cashfreeHealth(actor: Actor, options: { live?: boolean } = {}): Promise<CashfreeHealthReport> {
  assertFinanceView(actor);
  const env = getEnv();
  const site = deployedSiteKind(env);
  const base = paymentBaseUrl();
  const problems: string[] = [];

  const pgProblem = cashfreeEnvProblem("pg", env);
  const payoutProblem = env.CASHFREE_PAYOUT_CLIENT_ID ? cashfreeEnvProblem("payouts", env) : null;
  const verificationKeys = Boolean(
    (env.CASHFREE_VERIFICATION_CLIENT_ID && env.CASHFREE_VERIFICATION_CLIENT_SECRET) ||
      (env.CASHFREE_VERIFICATION_APP_ID && env.CASHFREE_VERIFICATION_SECRET_KEY) ||
      findCashfreeVerificationKeys(),
  );
  const verificationProblem = verificationKeys ? cashfreeEnvProblem("verification", env) : null;
  if (pgProblem) problems.push(`Payments: ${pgProblem}`);
  if (payoutProblem) problems.push(`Payouts: ${payoutProblem}`);
  if (verificationProblem) problems.push(`Secure ID: ${verificationProblem}`);
  if (!isPaymentGatewayLive()) problems.push("CASHFREE_APP_ID / CASHFREE_SECRET_KEY are not set: top-ups, the registration fee and the ₹1 check run in test (mock) mode.");
  if (site !== "local" && !base.startsWith("https://")) problems.push(`The public URL ${base} is not https: Cashfree cannot send webhooks to it.`);
  const siteHost = hostOf(env.AUTH_URL);
  if (site !== "local" && siteHost && hostOf(base) !== siteHost) problems.push(`PAYMENT_PUBLIC_BASE_URL (${base}) is not this site (${siteHost}).`);

  const [online, shopWallet, selfReg, payoutRule] = await Promise.all([
    getRule("onlinePayments"),
    getRule("shopWallet"),
    getRule("selfRegistration"),
    getRule("payouts"),
  ]);
  if (online.enabled && env.PAYMENT_GATEWAY === "SANDBOX" && site === "production") {
    problems.push("Online order payment is on but PAYMENT_GATEWAY is SANDBOX on the production site.");
  }

  const orderWebhook = webhookUrlFor("cashfree");
  const topUpWebhook = cashfreeNotifyUrl("/api/webhooks/cashfree") ?? null;
  const payoutWebhook = `${base}/api/webhooks/payouts/cashfree`;
  const report: CashfreeHealthReport = {
    checkedAt: new Date().toISOString(),
    site: { kind: site, host: siteHost, publicBaseUrl: base },
    problems,
    pg: {
      configured: isPaymentGatewayLive(),
      env: env.CASHFREE_ENV,
      apiBase: cashfreeApiBase(),
      apiVersion: CASHFREE_PG_API_VERSION,
      keyKind: cashfreeKeyKind(env.CASHFREE_APP_ID, env.CASHFREE_SECRET_KEY),
      orderGateway: env.PAYMENT_GATEWAY,
      webhookSecret: env.PAYMENT_WEBHOOK_SECRET_CASHFREE ? "PAYMENT_WEBHOOK_SECRET_CASHFREE" : env.CASHFREE_SECRET_KEY ? "CASHFREE_SECRET_KEY" : "none",
      refundSpeed: cashfreeRefundSpeed() ?? "STANDARD",
      checkoutScript: "https://sdk.cashfree.com/js/v3/cashfree.js",
    },
    urls: {
      topUpAndRegistrationWebhook: topUpWebhook,
      orderWebhook,
      payoutWebhook,
      registerInDashboard: [`${base}/api/webhooks/cashfree`, orderWebhook],
    },
    payouts: {
      configured: Boolean(env.CASHFREE_PAYOUT_CLIENT_ID && env.CASHFREE_PAYOUT_CLIENT_SECRET),
      env: env.CASHFREE_PAYOUT_ENV,
      provider: payoutRule.provider,
      apiBase: env.CASHFREE_PAYOUT_ENV === "production" ? "https://api.cashfree.com/payout" : "https://sandbox.cashfree.com/payout",
      problem: payoutProblem,
    },
    verification: {
      configured: verificationKeys,
      env: env.CASHFREE_VERIFICATION_ENV ?? env.CASHFREE_ENV,
      apiBase: (env.CASHFREE_VERIFICATION_ENV ?? env.CASHFREE_ENV) === "production" ? "https://api.cashfree.com/verification" : "https://sandbox.cashfree.com/verification",
      twoFactor: verificationKeys ? (env.CASHFREE_VERIFICATION_PUBLIC_KEY ? "SIGNATURE" : "IP_WHITELIST") : null,
      problem: verificationProblem,
    },
    rules: {
      onlinePaymentsEnabled: online.enabled,
      onlinePaymentMethods: [...online.methods],
      shopWalletEnabled: shopWallet.enabled,
      selfRegistrationEnabled: selfReg.enabled,
    },
    dashboardChecks: [
      `Payment Gateway → Developers → Webhooks: ${base}/api/webhooks/cashfree and ${orderWebhook} added, payment + refund events, version 2023-08-01.`,
      site === "production"
        ? "Payment Gateway → Developers → Whitelisting: gokesari.com (and www.gokesari.com) approved for production checkout."
        : "Sandbox: no domain whitelisting needed.",
      "Payment Gateway → Developers → Whitelisting → App: com.gokesari.app (Android) and the iOS bundle com.gokesari.app approved for the mobile SDK (production only).",
      "Settings → Payment methods: UPI, credit card, debit card, net banking and the wallets you want (Paytm, PhonePe, Amazon Pay …) activated — compare with the eligible list below.",
      "Payouts (when used): Developers → Two-Factor Authentication → this server's IP whitelisted; Payouts webhook V2 → " + payoutWebhook,
    ],
    live: null,
  };

  if (options.live && isPaymentGatewayLive()) {
    const keys = await askCashfreeKeys();
    const eligibility = await fetchEligiblePaymentMethods(1);
    report.live = { ...keys, eligibility };
    if (keys.keysAccepted === false) problems.push(`Cashfree refused this site's keys (HTTP ${keys.keysHttpStatus}) on ${cashfreeApiBase()}: the keys do not belong to the ${env.CASHFREE_ENV} environment.`);
    if (keys.apiVersionDeprecatedAt) problems.push(`Cashfree marks API version ${CASHFREE_PG_API_VERSION} deprecated at ${keys.apiVersionDeprecatedAt}.`);
  }
  return report;
}

/* ------------------------------------------------------------ ₹1 live test */

export interface LiveTestStarted {
  orderId: string;
  paymentSessionId: string;
  mode: "sandbox" | "production";
  amountPaise: number;
}

/** Opens a ₹1 Cashfree order for the admin to pay in Cashfree's checkout (any method the account has). */
export async function startCashfreeLiveTest(actor: Actor, options: { amountPaise?: number } = {}): Promise<LiveTestStarted> {
  assertFinanceManage(actor);
  const LIVE_TEST_AMOUNT_PAISE = (LIVE_TEST_AMOUNTS_PAISE as readonly number[]).includes(options.amountPaise ?? 100) ? (options.amountPaise ?? 100) : 100;
  if (!isPaymentGatewayLive()) throw conflict("Cashfree keys are not set on this site.");
  assertCashfreeEnvSafe("pg");
  const [user] = await db.select({ email: users.email, phone: users.phone }).from(users).where(eq(users.id, actor.id));
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const orderId = `${LIVE_TEST_PREFIX}${stamp}_${randomBytes(3).toString("hex")}`;
  const notifyUrl = cashfreeNotifyUrl("/api/webhooks/cashfree");
  const response = await fetch(`${cashfreeApiBase()}/orders`, {
    method: "POST",
    headers: pgHeaders(),
    body: JSON.stringify({
      order_id: orderId,
      order_amount: LIVE_TEST_AMOUNT_PAISE / 100,
      order_currency: "INR",
      customer_details: {
        customer_id: actor.id,
        customer_email: user?.email ?? undefined,
        customer_phone: (user?.phone ?? "").replace(/^\+91/, "") || "9999999999",
      },
      order_meta: {
        ...(notifyUrl ? { notify_url: notifyUrl } : {}),
        ...(paymentBaseUrl().startsWith("https://") ? { return_url: `${paymentBaseUrl()}/admin/payments/cashfree?test=${orderId}` } : {}),
      },
      order_expiry_time: cashfreeOrderExpiry(20),
      order_note: "GoKesari ₹1 payment test (refunded at once)",
      order_tags: { purpose: "gokesari_payment_test" },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error("[cashfree-test] order creation failed", response.status, text.slice(0, 500));
    throw conflict(`Cashfree refused the test order (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  const order = JSON.parse(text) as { order_id: string; payment_session_id?: string };
  if (!order.payment_session_id) throw conflict("Cashfree did not return a payment session.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CASHFREE_LIVE_TEST_STARTED,
    entityType: "cashfree_live_test",
    entityId: order.order_id,
    newValue: { env: getEnv().CASHFREE_ENV, amountPaise: LIVE_TEST_AMOUNT_PAISE, site: deployedSiteKind() },
  });
  return { orderId: order.order_id, paymentSessionId: order.payment_session_id, mode: getEnv().CASHFREE_ENV, amountPaise: LIVE_TEST_AMOUNT_PAISE };
}

export interface LiveTestAttempt {
  cfPaymentId: string;
  status: string;
  /** Cashfree's payment_group: upi, credit_card, debit_card, net_banking, wallet, … */
  group: string | null;
  /** The instrument in words (UPI app / card network + bank / wallet / bank) — never a card number. */
  instrument: string | null;
  amountPaise: number | null;
  time: string | null;
  message: string | null;
}

export interface LiveTestResult {
  orderId: string;
  env: "sandbox" | "production";
  orderStatus: string;
  paid: boolean;
  attempts: LiveTestAttempt[];
  /** The latest refund (null when the order was not paid). */
  refund: LiveTestRefund | null;
  /** Every refund on the order, oldest first (a partial-refund test has two). */
  refunds: LiveTestRefund[];
  /** What is still not refunded, in paise. */
  remainingPaise: number;
}

export interface LiveTestRefund {
  refundId: string;
  cfRefundId: string | null;
  status: string;
  amountPaise: number | null;
  speed: string | null;
  createdAt: string | null;
  processedAt: string | null;
}

interface CfPaymentRecord {
  cf_payment_id: string | number;
  payment_status: string;
  payment_group?: string;
  payment_amount?: number;
  payment_time?: string;
  payment_message?: string;
  payment_method?: {
    upi?: { channel?: string; upi_id?: string };
    card?: { card_network?: string; card_type?: string; card_bank_name?: string };
    app?: { provider?: string; channel?: string };
    netbanking?: { netbanking_bank_name?: string };
  };
}

function instrumentOf(p: CfPaymentRecord): string | null {
  const m = p.payment_method;
  if (!m) return null;
  if (m.upi) return `UPI ${m.upi.channel ?? ""}`.trim();
  if (m.card) return [m.card.card_type, m.card.card_network, m.card.card_bank_name].filter(Boolean).join(" · ") || "card";
  if (m.app) return `wallet ${m.app.provider ?? ""}`.trim();
  if (m.netbanking) return `net banking ${m.netbanking.netbanking_bank_name ?? ""}`.trim();
  return Object.keys(m)[0] ?? null;
}

const refundIdFor = (orderId: string, n: number) => `gktestrf_${orderId.slice(LIVE_TEST_PREFIX.length)}_${n}`.slice(0, 40);

/**
 * Reads the test order's result from Cashfree and refunds it straight away.
 * "full" (default): whatever is not refunded yet goes back. "partial": ₹1
 * goes back and the rest stays (for the ₹2 partial-refund test; finish it
 * again with "full" to refund the rest). Asking again never refunds twice.
 */
export async function finishCashfreeLiveTest(orderId: string, actor: Actor, options: { refund?: "full" | "partial" } = {}): Promise<LiveTestResult> {
  assertFinanceManage(actor);
  if (!orderId.startsWith(LIVE_TEST_PREFIX) || !/^[A-Za-z0-9_]{8,45}$/.test(orderId)) throw validationFailed("Not a payment-test order.");
  if (!isPaymentGatewayLive()) throw conflict("Cashfree keys are not set on this site.");
  assertCashfreeEnvSafe("pg");
  const [started] = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, AUDIT_ACTIONS.CASHFREE_LIVE_TEST_STARTED), eq(auditLogs.entityId, orderId)))
    .limit(1);
  if (!started) throw notFound("Payment test");

  const id = encodeURIComponent(orderId);
  const get = async <T>(path: string): Promise<{ status: number; body: T | null }> => {
    const response = await fetch(`${cashfreeApiBase()}${path}`, { method: "GET", headers: pgHeaders(), signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    return { status: response.status, body: response.ok ? (JSON.parse(text) as T) : null };
  };
  const order = await get<{ order_status: string; order_amount: number }>(`/orders/${id}`);
  if (!order.body) throw conflict(`Cashfree could not find the test order (HTTP ${order.status}).`);
  const payments = await get<CfPaymentRecord[]>(`/orders/${id}/payments`);
  const attempts: LiveTestAttempt[] = (payments.body ?? []).map((p) => ({
    cfPaymentId: String(p.cf_payment_id),
    status: p.payment_status,
    group: p.payment_group ?? null,
    instrument: instrumentOf(p),
    amountPaise: p.payment_amount != null ? Math.round(p.payment_amount * 100) : null,
    time: p.payment_time ?? null,
    message: p.payment_message ?? null,
  }));
  const paid = order.body.order_status === "PAID" || attempts.some((a) => a.status === "SUCCESS");

  type CfRefund = { refund_id?: string; cf_refund_id?: string | number; refund_status: string; refund_amount?: number; refund_speed?: { requested?: string; processed?: string }; created_at?: string; processed_at?: string };
  const toRefund = (r: CfRefund): LiveTestRefund => ({
    refundId: r.refund_id ?? "?",
    cfRefundId: r.cf_refund_id != null ? String(r.cf_refund_id) : null,
    status: r.refund_status,
    amountPaise: r.refund_amount != null ? Math.round(r.refund_amount * 100) : null,
    speed: r.refund_speed?.processed ?? r.refund_speed?.requested ?? null,
    createdAt: r.created_at ?? null,
    processedAt: r.processed_at ?? null,
  });
  const orderPaise = Math.round(Number(order.body.order_amount) * 100);
  const listRefunds = async () => ((await get<CfRefund[]>(`/orders/${id}/refunds`)).body ?? []).filter((r) => (r.refund_id ?? "").startsWith("gktestrf_"));
  let refunds: CfRefund[] = paid ? await listRefunds() : [];
  const refunded = () => refunds.filter((r) => r.refund_status !== "CANCELLED").reduce((sum, r) => sum + Math.round(Number(r.refund_amount ?? 0) * 100), 0);
  if (paid) {
    const remaining = orderPaise - refunded();
    const amountPaise = options.refund === "partial" ? (remaining > 100 ? 100 : 0) : remaining;
    if (amountPaise > 0) {
      const speed = cashfreeRefundSpeed();
      const refundId = refundIdFor(orderId, refunds.length + 1);
      const response = await fetch(`${cashfreeApiBase()}/orders/${id}/refunds`, {
        method: "POST",
        headers: pgHeaders(),
        body: JSON.stringify({ refund_amount: amountPaise / 100, refund_id: refundId, refund_note: "GoKesari payment test", ...(speed ? { refund_speed: speed } : {}) }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      if (response.ok) refunds = [...refunds.filter((r) => r.refund_id !== refundId), { refund_id: refundId, ...(JSON.parse(text) as CfRefund) }];
      else {
        console.error("[cashfree-test] refund failed", orderId, response.status, text.slice(0, 300));
        refunds = [...refunds, { refund_id: refundId, refund_status: `NOT_CREATED (HTTP ${response.status}: ${text.slice(0, 120)})`, refund_amount: 0 }];
      }
    }
  }
  const refundList = refunds.map(toRefund);
  const refund = refundList.at(-1) ?? null;
  const result: LiveTestResult = { orderId, env: getEnv().CASHFREE_ENV, orderStatus: order.body.order_status, paid, attempts, refund, refunds: refundList, remainingPaise: paid ? orderPaise - refunded() : orderPaise };
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CASHFREE_LIVE_TEST_FINISHED,
    entityType: "cashfree_live_test",
    entityId: orderId,
    newValue: result as unknown as Record<string, unknown>,
  });
  return result;
}

/** The last test results recorded on this site (newest first), for the admin page and the testing report. */
export async function listCashfreeLiveTests(actor: Actor, limit = 30) {
  assertFinanceView(actor);
  const rows = await db
    .select({ action: auditLogs.action, entityId: auditLogs.entityId, newValue: auditLogs.newValue, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "cashfree_live_test"), inArray(auditLogs.action, [AUDIT_ACTIONS.CASHFREE_LIVE_TEST_STARTED, AUDIT_ACTIONS.CASHFREE_LIVE_TEST_FINISHED])))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
