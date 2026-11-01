/**
 * Billing v2's daily work (docs/billing §5.7, §6.1, §9), run by the 05:00 IST
 * daily cron (cron/schedule.ts) and by /api/cron/compliance-reminders by hand.
 * Nothing while billing_v2 is off.
 *
 *   - admins: GoKesari's own returns due within three days, or overdue;
 *   - s.9(5) delivery-fee invoices that could not be issued at delivery;
 *   - GoKesari's orders, fees, taxes and payouts posted into every shop's books;
 *   - shop owners: last month's statements are ready (from the 2nd);
 *   - shop owners whose GST portal link ends within a day;
 *   - credit-note IRNs still due (einvoice flag).
 */
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { istDay } from "@/server/statutory/rates";

export async function runBillingDaily(now: Date = new Date()) {
  if (!(await isFeatureEnabled("billing_v2"))) return { skipped: "billing_v2 is off" };
  const today = istDay(now);
  const { sendComplianceReminders } = await import("./compliance");
  const { issueMissingDeliveryFeeInvoices } = await import("./money-flow");
  const { postGokesariActivityForAllShops } = await import("@/server/accounts/platform-posting");
  const { sendMonthlyShopStatements } = await import("./statements");
  const { sendGstSessionReminders } = await import("@/server/gsp/returns");
  const { issuePendingCreditNoteEinvoices } = await import("@/server/gst/einvoice-extras");
  return {
    reminders: await sendComplianceReminders(today),
    deliveryInvoices: await issueMissingDeliveryFeeInvoices(),
    books: await postGokesariActivityForAllShops(),
    statements: await sendMonthlyShopStatements(today),
    gstSessions: await sendGstSessionReminders(30),
    creditNoteIrns: (await isFeatureEnabled("einvoice")) ? await issuePendingCreditNoteEinvoices() : null,
  };
}
