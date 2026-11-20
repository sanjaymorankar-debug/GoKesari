/**
 * GoKesari Health: medical equipment rentals (rent + deposit, delivery OTP, due reminders, extension,
 * return pickup, condition check, deposit refund). (Being built.)
 */
import type { DbClient } from "@/server/db";
import type { PaymentIntentRow, ScheduledNotice } from "@/server/db/schema";
import type { PaymentIntentRef } from "@/server/payments/intents";
import type { AfterCommit } from "@/server/payments/purpose-handlers";

export async function onRentalPaymentCaptured(intent: PaymentIntentRef, client: DbClient, afterCommit?: AfterCommit): Promise<void> {
  void intent;
  void client;
  void afterCommit;
}
export async function onRentalPaymentEnded(intent: PaymentIntentRow, to: "FAILED" | "EXPIRED", client: DbClient): Promise<void> {
  void intent;
  void to;
  void client;
}
export async function sendRentalDueNotice(notice: ScheduledNotice): Promise<boolean> {
  void notice;
  return false;
}
