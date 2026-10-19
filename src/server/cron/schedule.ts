/**
 * The whole cron schedule in three entry points (owner, 19 Oct 2026).
 *
 * Every action and notification is triggered by its event (docs/event-driven-2026-10).
 * The scheduler only covers what no event can trigger: a deadline that passed,
 * a retry after a failed send, a gateway webhook that never arrived, a timed
 * send, the nightly subscription orders and the Saturday payout. Instead of one
 * crontab line per job, three routes run every job at its own cadence:
 *
 *   /api/cron/every-minute   every minute
 *   /api/cron/hourly         once an hour
 *   /api/cron/daily          05:00 IST
 *
 * Each job here is the body of its own /api/cron/<job> route, which stays for a
 * manual run or a rollback. Every job is idempotent and safe to overlap, so a
 * late or repeated run is harmless; one job failing never stops the others.
 * Each job loads its service when it runs (dynamic import), so a route loads
 * only what it calls and a module that fails to load fails only its own job.
 */
import { addDays, isoWeekday, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { getRule } from "@/server/services/settings";

const SYSTEM = { id: null, role: null };

/** Runs one part; a failure is recorded in `errors` and the rest still run. */
export async function step<T>(tag: string, name: string, errors: string[], run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`[cron:${tag}] ${name} failed`, error);
    return null;
  }
}

/* ------------------------------------------------------------- the jobs */

/** Shop not accepted in time, rider offers and retries, no rider found, return pickups, shop-open alerts. */
export async function timeoutSweep() {
  const errors: string[] = [];
  const shopAcceptance = await step("timeout-sweep", "shop-acceptance", errors, async () => (await import("@/server/services/shop-acceptance")).runShopAcceptanceSweep());
  // batch-2026-10 WS-B: broadcast stale single offers / widen the radius (rule
  // dispatchBroadcast) before stale offers are expired below. Reported only when on.
  const broadcast = await step("timeout-sweep", "dispatch-broadcast", errors, async () => (await import("@/server/services/dispatch-broadcast")).runBroadcastSweep());
  return {
    shopAcceptance,
    ...(broadcast?.enabled ? { dispatchBroadcast: broadcast } : {}),
    dispatch: await step("timeout-sweep", "dispatch", errors, async () => (await import("@/server/services/delivery-assignment")).runDispatchSweep()),
    riderSearchAlerts: await step("timeout-sweep", "rider-search-alerts", errors, async () => (await import("@/server/services/delivery-assignment")).alertOverdueRiderSearches()),
    returnPickups: await step("timeout-sweep", "return-pickups", errors, async () => (await import("@/server/services/return-pickups")).runReturnPickupSweep()),
    shopOpening: await step("timeout-sweep", "shop-opening", errors, async () => (await import("@/server/services/shop-opening")).sendShopOpeningAlerts()),
    errors,
  };
}

/** Accounting-integration retries; does nothing while inventory sync is descoped (rule inventorySync). */
export async function integrationSync() {
  if (!(await (await import("@/server/integrations/inventory-sync-flag")).inventorySyncEnabled())) return { skipped: true, reason: "INVENTORY_SYNC_DISABLED" };
  return (await import("@/server/integrations/sweep")).integrationSweep();
}

/** Next batches of each running product-data import. */
export async function pmdIngest() {
  const result = await (await import("@/server/pmd/ingest-jobs")).processDueJobs();
  return { jobs: result.jobs, errors: result.errors, progressed: result.progressed.map((p) => ({ id: p.id, status: p.status, percent: p.percent })) };
}

/** Online payments whose webhook never came, queued / pending gateway refunds, and the refund timelines that follow them. */
export async function paymentsReconcile() {
  const payments = await (await import("@/server/payments/processing")).runPaymentReconciliation();
  const orderRefunds = await (await import("@/server/aftercare/refunds")).runRefundSweep();
  return { ...payments, orderRefunds };
}

/** Help-desk deadlines (acknowledge / resolve, auto-close) and refund retries. */
export async function aftercare() {
  const helpdesk = await (await import("@/server/aftercare/support-tickets")).runHelpdeskSlaSweep();
  const refunds = await (await import("@/server/aftercare/refunds")).runRefundSweep();
  return { helpdesk, refunds };
}

/** Document upkeep: vendor retries, GST re-check, expiry, lapse, DPDP erasure, stuck-review reminder, retention purges. */
export async function sellerVerification() {
  const result = await (await import("@/server/services/seller-verification-jobs")).runSellerVerificationSweep();
  // Mandatory legal documents (docs/four-features-2026-10): grace periods and expiry reminders.
  const legalDocuments = await (await import("@/server/services/legal-documents")).runLegalDocumentSweep().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  // docs/document-upload-2026-10: uploads never submitted lose their file and read fields after the retention period.
  const staleUploadsPurged = await (await import("@/server/services/document-uploads")).purgeStaleUploads().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  // docs/product-import-2026-10: bulk-upload files and staged rows are deleted after the retention period.
  const productImportsPurged = await (await import("@/server/services/product-import")).purgeOldProductImports().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  return { ...result, legalDocuments, staleUploadsPurged, productImportsPurged };
}

/** Closes a payout cycle that has ended (weekly, Saturday) and drafts its batch; retries failed transfers. */
export async function payoutCycle() {
  const emails = await (await import("@/server/documents/email")).deliverDocumentEmails();
  if (!(await getRule("payouts")).enabled) return { skipped: "Automated payouts are off (rule payouts).", emails };
  const closed = await (await import("@/server/payouts/cycle")).closePayoutCycle({ actor: SYSTEM });
  const retried = await (await import("@/server/payouts/batches")).retryFailedPayouts({ actor: SYSTEM });
  return {
    cycle: closed ? { id: closed.cycle.id, start: closed.cycle.cycleStart, end: closed.cycle.cycleEnd, created: closed.created } : null,
    batchId: closed?.batch?.id ?? null,
    items: closed?.items.length ?? 0,
    retried,
    emails,
  };
}

/** Failed payout transfers whose backoff has passed. */
export async function payoutRetries() {
  if (!(await getRule("payouts")).enabled) return { skipped: "Automated payouts are off (rule payouts)." };
  return (await import("@/server/payouts/batches")).retryFailedPayouts({ actor: SYSTEM });
}

/** Rider payouts and reconciliation for the previous Monday-Sunday week; shop settlements only while automated payouts are off. */
export async function financeWeekly() {
  const finance = await import("@/server/services/finance");
  const weekStart = finance.previousWeekStart();
  // batch-2026-10 WS-E: with automated payouts on, shops are paid by the payout cycle instead.
  const payoutsOn = (await getRule("payouts")).enabled;
  const settlements = payoutsOn ? [] : await finance.prepareShopSettlements(weekStart, SYSTEM);
  const payouts = await finance.prepareRiderPayouts(weekStart, SYSTEM);
  const today = todayIn(getEnv().APP_TIMEZONE);
  const reconciliation = await finance.runReconciliation(addDays(today, -35), addDays(today, 1), SYSTEM);
  return { weekStart, settlements: settlements.length, payouts: payouts.length, reconciliation, ...(payoutsOn ? { shopSettlements: "payout-cycle" } : {}) };
}

/* -------------------------------------------------------------- schedule */

interface Job {
  name: string;
  /** every-minute group only: run when the UTC minute is a multiple of this (1 = every minute). */
  everyMinutes?: number;
  /** daily group only: ISO weekday (1 = Monday) in the app time zone on which it runs. */
  weekday?: number;
  run: () => Promise<unknown>;
}

/** The order is the order of urgency: customer-facing timeouts first, long imports last. */
export const EVERY_MINUTE: readonly Job[] = [
  { name: "timeout-sweep", run: timeoutSweep },
  { name: "notification-retry", run: async () => (await import("@/server/services/notifications")).deliverPending() },
  { name: "broadcast-dispatch", run: async () => (await import("@/server/services/broadcasts")).dispatchBroadcasts() },
  { name: "integration-sync", run: integrationSync },
  { name: "payments-reconcile", everyMinutes: 5, run: paymentsReconcile },
  { name: "operator-onboarding", everyMinutes: 5, run: async () => (await import("@/server/services/operator-limited")).sweepOnboardingFees() },
  { name: "document-emails", everyMinutes: 5, run: async () => (await import("@/server/documents/email")).deliverDocumentEmails() },
  { name: "bill-captures", everyMinutes: 10, run: async () => (await import("@/server/accounts/capture/service")).dispatchCaptures(10) },
  { name: "push-receipts", everyMinutes: 15, run: async () => (await import("@/server/notifications/push/receipts")).checkPushReceipts() },
  { name: "pmd-ingest", run: pmdIngest },
];

export const HOURLY: readonly Job[] = [
  { name: "risk-rules", run: async () => (await import("@/server/services/risk")).runRiskRules(SYSTEM) },
  { name: "dispute-escalation", run: async () => (await import("@/server/services/disputes")).runDisputeEscalationSweep() },
  { name: "aftercare", run: aftercare },
  { name: "payout-retries", run: payoutRetries },
  { name: "auth-housekeeping", run: async () => ({ otps: await (await import("@/server/otp/housekeeping")).purgeExpiredOtps() }) },
];

/** Runs at 05:00 IST: subscription orders first, before the morning deliveries. */
export const DAILY: readonly Job[] = [
  { name: "daily-orders", run: async () => (await import("@/server/services/subscriptions")).generateDailyOrders() },
  { name: "seller-verification", run: sellerVerification },
  { name: "gst-reminders", run: async () => (await import("@/server/accounts/gst")).sendGstReminders() },
  // Weekly payouts every Saturday morning (rule payouts: 7 days from a Saturday);
  // a no-op on other days, and on a Sunday it closes a Saturday cycle a failed run missed.
  { name: "payout-cycle", run: payoutCycle },
  { name: "finance-weekly", weekday: 1, run: financeWeekly },
];

/** The jobs of an every-minute run at `now`. */
export function dueEveryMinute(now: Date): readonly Job[] {
  const minute = now.getUTCMinutes();
  return EVERY_MINUTE.filter((job) => minute % (job.everyMinutes ?? 1) === 0);
}

/** The jobs of a daily run on `today` (a date in the app time zone). */
export function dueDaily(today: string): readonly Job[] {
  const weekday = isoWeekday(today as Parameters<typeof isoWeekday>[0]);
  return DAILY.filter((job) => job.weekday === undefined || job.weekday === weekday);
}

async function runAll(tag: string, jobs: readonly Job[]) {
  const errors: string[] = [];
  const results: Record<string, unknown> = {};
  for (const job of jobs) results[job.name] = await step(tag, job.name, errors, job.run);
  const summary = { ran: jobs.map((j) => j.name), results, errors };
  console.info(`[cron:${tag}]`, JSON.stringify(summary));
  return summary;
}

export function runEveryMinute(now: Date = new Date()) {
  return runAll("every-minute", dueEveryMinute(now));
}

export function runHourly() {
  return runAll("hourly", HOURLY);
}

export function runDaily(now: Date = new Date()) {
  return runAll("daily", dueDaily(todayIn(getEnv().APP_TIMEZONE, now)));
}
