/**
 * F13.1.2: Expo push receipts. A ticket only says Expo took the message; the
 * receipt (available ~15 minutes later, kept by Expo for about a day) says
 * whether FCM / APNs accepted it. DeviceNotRegistered there also retires the
 * token. Run by cron push-receipts (every 15 minutes is plenty).
 */
import { and, eq, inArray, lte } from "drizzle-orm";

import { db } from "@/server/db";
import { pushTickets } from "@/server/db/schema";
import { getRule } from "@/server/services/settings";
import { getPushProvider } from "./provider";
import { deactivatePushTokens } from "./tokens";
import { DEVICE_NOT_REGISTERED, type PushProvider } from "./types";

/** Expo keeps receipts for about a day; after that a missing one will never come. */
const RECEIPT_GIVE_UP_MS = 24 * 60 * 60_000;

export async function checkPushReceipts(
  options: { now?: Date; limit?: number; provider?: PushProvider } = {},
): Promise<{ checked: number; delivered: number; errors: number; deactivated: number; expired: number }> {
  const rules = await getRule("push");
  const now = options.now ?? new Date();
  const tally = { checked: 0, delivered: 0, errors: 0, deactivated: 0, expired: 0 };
  const due = await db
    .select()
    .from(pushTickets)
    .where(
      and(
        eq(pushTickets.status, "PENDING_RECEIPT"),
        lte(pushTickets.createdAt, new Date(now.getTime() - rules.receiptDelayMinutes * 60_000)),
      ),
    )
    .orderBy(pushTickets.createdAt)
    .limit(options.limit ?? 1000);
  if (due.length === 0) return tally;

  for (const providerName of ["mock", "expo"] as const) {
    const tickets = due.filter((t) => t.provider === providerName && t.ticketId);
    if (tickets.length === 0) continue;
    const provider = options.provider ?? getPushProvider({ provider: providerName });
    const receipts = await provider.getReceipts(tickets.map((t) => t.ticketId!));
    const gone: string[] = [];
    for (const ticket of tickets) {
      tally.checked += 1;
      const receipt = receipts[ticket.ticketId!];
      if (!receipt) {
        if (now.getTime() - ticket.createdAt.getTime() > RECEIPT_GIVE_UP_MS) {
          await db
            .update(pushTickets)
            .set({ status: "ERROR", errorCode: "NoReceipt", errorMessage: "No receipt within a day.", checkedAt: now })
            .where(eq(pushTickets.id, ticket.id));
          tally.expired += 1;
        }
        continue;
      }
      await db
        .update(pushTickets)
        .set({
          status: receipt.ok ? "DELIVERED" : "ERROR",
          errorCode: receipt.ok ? null : (receipt.errorCode ?? null),
          errorMessage: receipt.ok ? null : (receipt.errorMessage ?? null),
          checkedAt: now,
        })
        .where(eq(pushTickets.id, ticket.id));
      if (receipt.ok) tally.delivered += 1;
      else {
        tally.errors += 1;
        if (receipt.errorCode === DEVICE_NOT_REGISTERED) gone.push(ticket.pushTokenId);
      }
    }
    if (gone.length > 0) {
      await deactivatePushTokens([...new Set(gone)], DEVICE_NOT_REGISTERED);
      tally.deactivated += new Set(gone).size;
    }
  }
  return tally;
}

/** Tickets for one delivery (the admin delivery log shows them next to the attempts). */
export async function ticketsForDeliveries(deliveryIds: string[]) {
  if (deliveryIds.length === 0) return [];
  return db.select().from(pushTickets).where(inArray(pushTickets.deliveryId, deliveryIds));
}
