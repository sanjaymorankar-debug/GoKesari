/**
 * F13.1.2: the push provider contract. The PUSH notification channel
 * (./channel.ts) talks to whichever provider the `push` rule names:
 *
 *   mock  writes each push to the test outbox (outbound_test_messages,
 *         readable at /admin/test-messages) — test site and development only
 *   expo  Expo's push service (./expo.ts), which hands the message to FCM
 *         (Android) and APNs (iOS) for the GoKesari app
 *
 * A provider sends one message per device token and answers with one ticket
 * per message, in the same order. Receipts (did FCM/APNs accept it?) are read
 * later with the ticket ids.
 */

export interface PushMessage {
  /** The device's Expo push token. */
  to: string;
  title: string;
  body: string;
  /** Delivered to the app with the notification; the app opens `url` when it is tapped. */
  data?: { url?: string | null; [key: string]: unknown };
  sound?: "default" | null;
  /** Android notification channel (created by the app). */
  channelId?: string;
}

export interface PushTicketResult {
  token: string;
  ok: boolean;
  /** Provider's ticket id when ok — used to read the receipt. */
  ticketId?: string;
  /** Provider's error code (Expo: DeviceNotRegistered, MessageTooBig, MessageRateExceeded, InvalidCredentials …). */
  errorCode?: string;
  errorMessage?: string;
}

export interface PushReceiptResult {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface PushProvider {
  readonly name: "mock" | "expo";
  send(messages: PushMessage[]): Promise<PushTicketResult[]>;
  /** Receipts by ticket id; an id missing from the answer has no receipt yet. */
  getReceipts(ticketIds: string[]): Promise<Record<string, PushReceiptResult>>;
}

/**
 * The provider could not take the request right now (network, HTTP 5xx, 429,
 * rate limit). The delivery is marked FAILED and retried on the backoff in
 * rule `notifications`; every attempt is counted in notification_deliveries.
 */
export class PushTransientError extends Error {}

/** Expo's error code for a token whose app was uninstalled or whose notifications were switched off. */
export const DEVICE_NOT_REGISTERED = "DeviceNotRegistered";

/** Errors worth trying again later (everything else is permanent for that message). */
export const TRANSIENT_PUSH_ERRORS: readonly string[] = ["MessageRateExceeded"];

/** ExponentPushToken[…] or ExpoPushToken[…]. */
export function isExpoPushToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^Expo(nent)?PushToken\[[A-Za-z0-9_\-:.]+\]$/.test(value);
}
