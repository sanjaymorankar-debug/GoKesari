/**
 * GoKesari Health: prescriptions forwarded to medical stores (request → quote → approve / pay →
 * pickup or delivery with OTP → bill), dispensed quantities, settlement. (Being built.)
 */
import type { DbClient } from "@/server/db";
import type { PaymentIntentRow, ScheduledNotice } from "@/server/db/schema";
import type { PaymentIntentRef } from "@/server/payments/intents";
import type { AfterCommit } from "@/server/payments/purpose-handlers";

export async function onRxOrderPaymentCaptured(intent: PaymentIntentRef, client: DbClient, afterCommit?: AfterCommit): Promise<void> {
  void intent;
  void client;
  void afterCommit;
}
export async function onRxOrderPaymentEnded(intent: PaymentIntentRow, to: "FAILED" | "EXPIRED", client: DbClient): Promise<void> {
  void intent;
  void to;
  void client;
}
export async function expireRxOrderNotice(notice: ScheduledNotice): Promise<boolean> {
  void notice;
  return false;
}
