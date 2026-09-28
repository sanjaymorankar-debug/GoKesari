/**
 * Notification service (requirement §49).
 *
 * In-app notifications are persisted; other channels are dispatched through a
 * pluggable transport so SMS/push can be added later without touching callers.
 * Email uses a console transport until SMTP credentials are configured — the
 * seam exists so wiring a provider is a one-file change.
 */
import { and, count, desc, eq, isNull } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import { notifications, type Notification } from "@/server/db/schema";

export const NOTIFICATION_TYPES = {
  SHOP_APPROVED: "shop.approved",
  SHOP_REJECTED: "shop.rejected",
  /** DEF-02 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): a shop previously learned about a new order only by refreshing /shop/orders. */
  SHOP_NEW_ORDER: "shop.new_order",
  ORDER_CONFIRMED: "order.confirmed",
  ORDER_ACCEPTED: "order.accepted",
  ORDER_ASSIGNED: "order.assigned",
  ORDER_DELIVERY_FAILED: "order.delivery_failed",
  /** Shop proposed a replacement for an unavailable item; customer must decide. */
  ORDER_SUBSTITUTION_PROPOSED: "order.substitution_proposed",
  ORDER_ITEM_REMOVED: "order.item_removed",
  /** To the shop: no rider accepted yet — the system keeps retrying. */
  DELIVERY_UNASSIGNED: "delivery.unassigned",
  /* ---------------------------------------------------- Phase 2 */
  SOCIETY_VERIFIED: "society.verified",
  SOCIETY_REJECTED: "society.rejected",
  SOCIETY_MEMBERSHIP_REQUESTED: "society.membership_requested",
  SOCIETY_MEMBERSHIP_DECIDED: "society.membership_decided",
  /** To society admins/operators: a rider is on the way to a society home (GS-046). */
  SOCIETY_SECURITY_ALERT: "society.security_alert",
  /** To the customer after delivery: rate the shop and rider. */
  RATING_REQUESTED: "rating.requested",
  SUBSCRIPTION_RESUMED: "subscription.resumed",
  SUBSCRIPTION_CANCELLED: "subscription.cancelled",
  ORDER_READY: "order.ready",
  ORDER_OUT_FOR_DELIVERY: "order.out_for_delivery",
  ORDER_DELIVERED: "order.delivered",
  ORDER_CANCELLED: "order.cancelled",
  WALLET_TOPUP_SUCCESS: "wallet.topup_success",
  WALLET_LOW_BALANCE: "wallet.low_balance",
  SUBSCRIPTION_CREATED: "subscription.created",
  SUBSCRIPTION_MODIFIED: "subscription.modified",
  SUBSCRIPTION_SKIPPED: "subscription.skipped",
  SUBSCRIPTION_PAUSED: "subscription.paused",
  SUBSCRIPTION_ORDER_CREATED: "subscription.order_created",
  SUBSCRIPTION_PAYMENT_FAILED: "subscription.payment_failed",
  SUBSCRIPTION_UPCOMING_REMINDER: "subscription.upcoming_reminder",
  PRICE_CHANGED: "product.price_changed",
  GRIEVANCE_ACKNOWLEDGED: "grievance.acknowledged",
  GRIEVANCE_RESOLVED: "grievance.resolved",
  DELIVERY_PARTNER_APPROVED: "delivery_partner.approved",
  DELIVERY_PARTNER_REJECTED: "delivery_partner.rejected",
  DELIVERY_PARTNER_SUSPENDED: "delivery_partner.suspended",
  DELIVERY_OFFERED: "delivery.offered",
  SHOP_GST_VERIFIED: "shop.gst_verified",
  SHOP_GST_REJECTED: "shop.gst_rejected",
  SHOP_PAN_VERIFIED: "shop.pan_verified",
  SHOP_PAN_REJECTED: "shop.pan_rejected",
  STOCK_LOW: "inventory.stock_low",
} as const;

export type NotificationType =
  (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  channels?: ("IN_APP" | "EMAIL" | "SMS" | "PUSH")[];
  /**
   * When set, the notification is written at most once for this key. Used for
   * things like a single low-balance warning per threshold crossing.
   */
  dedupeKey?: string;
}

/**
 * Writes the notification(s). Never throws — a failed notification must not
 * roll back the business operation that triggered it.
 */
export async function notify(
  input: NotifyInput,
  client: DbClient = db,
): Promise<void> {
  const channels = input.channels ?? ["IN_APP"];
  try {
    for (const channel of channels) {
      if (channel === "IN_APP") {
        await client
          .insert(notifications)
          .values({
            userId: input.userId,
            type: input.type,
            channel,
            title: input.title,
            body: input.body,
            actionUrl: input.actionUrl ?? null,
            metadata: input.metadata ?? null,
            dedupeKey: input.dedupeKey ?? null,
            sentAt: new Date(),
          })
          // Relies on the unique index over dedupe_key.
          .onConflictDoNothing();
      } else {
        await dispatchExternal(channel, input);
      }
    }
  } catch (error) {
    console.error("[notifications] failed to deliver", input.type, error);
  }
}

/**
 * Outbound transport seam. Swap the body of this function for a real provider
 * (SES/SendGrid for email, MSG91/Twilio for SMS, FCM for push).
 */
async function dispatchExternal(
  channel: "EMAIL" | "SMS" | "PUSH",
  input: NotifyInput,
): Promise<void> {
  console.info(
    `[notifications:${channel}] to=${input.userId} type=${input.type} :: ${input.title} — ${input.body}`,
  );
}

export async function listNotifications(
  userId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.channel, "IN_APP"),
        options.unreadOnly ? isNull(notifications.readAt) : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(options.limit ?? 30, 100));
}

export async function unreadCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.channel, "IN_APP"),
        isNull(notifications.readAt),
      ),
    );
  return row?.value ?? 0;
}

export async function markRead(
  userId: string,
  notificationId: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId),
      ),
    );
}

export async function markAllRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.userId, userId), isNull(notifications.readAt)),
    );
}
