/**
 * GoKesari Health Prime: listing plans, subscriptions, renewal, expiry, priority placement, call tracking.
 * (Being built: docs/health/README.md "Prime".)
 */
import type { DbClient } from "@/server/db";
import type { ConsultBooking, PaymentIntentRow, ScheduledNotice } from "@/server/db/schema";
import type { PaymentIntentRef } from "@/server/payments/intents";
import type { AfterCommit } from "@/server/payments/purpose-handlers";

export async function onPrimePaymentCaptured(intent: PaymentIntentRef, client: DbClient, afterCommit?: AfterCommit): Promise<void> {
  void intent;
  void client;
  void afterCommit;
}
export async function onPrimePaymentEnded(intent: PaymentIntentRow, to: "FAILED" | "EXPIRED", client: DbClient): Promise<void> {
  void intent;
  void to;
  void client;
}
export async function sendPrimeRenewalNotice(notice: ScheduledNotice): Promise<boolean> {
  void notice;
  return false;
}
export async function applyPrimeExpiryNotice(notice: ScheduledNotice): Promise<boolean> {
  void notice;
  return false;
}
/** Pay-per-booking fee and booking analytics for a new Health booking. */
export async function onHealthBookingCreated(booking: ConsultBooking): Promise<void> {
  void booking;
}
