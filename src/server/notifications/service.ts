/**
 * NotificationService (F13.1.2, GS-074) — the one way every channel is used.
 *
 * A thin facade over the existing notification framework; it adds no
 * behaviour of its own:
 *
 *   events      server/events/emit.ts → notify() for each person in the catalogue
 *   templates   server/notifications/templates.ts (every type has one; email default per type)
 *   preferences notification_preferences (per person × category × channel; security notices always)
 *   channels    IN_APP (notifications row)  EMAIL (SMTP)  PUSH (Expo / mock, rule push)
 *               SMS, WHATSAPP (mock until Phase 2 — providers/)
 *   delivery    notification_deliveries: the outbox and delivery log — every attempt,
 *               retries on the backoff in rule notifications, DEAD + support alert after N;
 *               push keeps a ticket per device in push_tickets and reads Expo receipts later
 *   centre      the bell panel and /notifications (read / unread per person, expired broadcasts hidden)
 */
import {
  deliverPending,
  getPreferenceMatrix,
  markAllRead,
  markRead,
  notify,
  notifyEvent,
  setPreference,
  unreadCount,
} from "@/server/services/notifications";
import { getOwnNotification, listNotificationCentre } from "./centre";
import { checkPushReceipts } from "./push/receipts";
import { registerPushToken, unregisterPushToken } from "./push/tokens";

export const NotificationService = {
  /** Event → in-app row now + queued outbound deliveries by template and preferences. Never throws. */
  notify,
  notifyEvent,
  /** Sends due deliveries (all channels) and retries failed ones. */
  deliverPending,
  /** Expo receipts for push tickets; retires unregistered devices. */
  checkPushReceipts,
  preferences: getPreferenceMatrix,
  setPreference,
  registerPushToken,
  unregisterPushToken,
  list: listNotificationCentre,
  get: getOwnNotification,
  unreadCount,
  markRead,
  markAllRead,
} as const;

export type NotificationServiceType = typeof NotificationService;
