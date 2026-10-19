/**
 * F13.1.2: the PUSH notification channel. notify() queues a PUSH delivery in
 * notification_deliveries like any other channel; deliverPending() hands it
 * here. One delivery fans out to every active device of the person:
 *
 *   some device accepted        → SENT (no retry, so nobody gets it twice)
 *   provider unreachable / busy → thrown → FAILED, retried on the backoff in
 *                                 rule `notifications` (attempts counted), then DEAD
 *   every device unregistered   → tokens deactivated, delivery SKIPPED
 *   rule push.enabled off       → SKIPPED, as before push existed
 *
 * Each device's ticket is kept in push_tickets for the receipt check.
 */
import { getRule } from "@/server/services/settings";
import { db } from "@/server/db";
import { pushTickets } from "@/server/db/schema";
import { ChannelUnavailableError, type ChannelMessage, type ChannelProvider } from "../channels";
import { getPushProvider, pushConfigProblem } from "./provider";
import { activePushTokens, deactivatePushTokens } from "./tokens";
import { DEVICE_NOT_REGISTERED, PushTransientError, TRANSIENT_PUSH_ERRORS, type PushProvider } from "./types";

const ADDRESS_PREFIX = "user:";

/** Title and body for the push, from the queued delivery ("<title> — Gokesari" and the email text). */
export function pushContent(message: Pick<ChannelMessage, "subject" | "text">): { title: string; body: string } {
  const title = message.subject.replace(/\s+—\s+Gokesari$/i, "").trim();
  const paragraphs = message.text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^https?:\/\/\S+$/.test(p) && !p.startsWith("You receive this because of your notification settings"));
  const body = (paragraphs[0] === title ? paragraphs.slice(1) : paragraphs).join("\n").replace(/[ \t]+/g, " ").trim();
  return { title: title.slice(0, 120), body: (body || title).slice(0, 400) };
}

/** True when rule push is on and its provider may run here. */
export async function isPushEnabled(): Promise<boolean> {
  const rules = await getRule("push");
  return rules.enabled && !pushConfigProblem(rules);
}

export async function sendPushForDelivery(
  message: ChannelMessage,
  options: { provider?: PushProvider } = {},
): Promise<{ providerRef?: string }> {
  const rules = await getRule("push");
  if (!rules.enabled) throw new ChannelUnavailableError("Push notifications are switched off (rule push).");
  const problem = pushConfigProblem(rules);
  if (problem) throw new ChannelUnavailableError(problem);
  if (!message.to.startsWith(ADDRESS_PREFIX)) throw new ChannelUnavailableError("No user for this push.");
  const userId = message.to.slice(ADDRESS_PREFIX.length);

  const tokens = await activePushTokens(userId);
  if (tokens.length === 0) throw new ChannelUnavailableError("The person has no signed-in app with notifications on.");

  const provider = options.provider ?? getPushProvider(rules);
  const { title, body } = pushContent(message);
  const results = await provider.send(
    tokens.map((t) => ({
      to: t.token,
      title,
      body,
      data: { url: message.actionUrl ?? null, deliveryId: message.deliveryId ?? null },
      sound: "default" as const,
      channelId: rules.androidChannelId,
    })),
  );

  const tokenByValue = new Map(tokens.map((t) => [t.token, t]));
  const rows = results
    .map((r) => {
      const token = tokenByValue.get(r.token);
      if (!token) return null;
      return {
        deliveryId: message.deliveryId ?? null,
        userId,
        pushTokenId: token.id,
        provider: provider.name,
        ticketId: r.ticketId ?? null,
        status: r.ok ? ("PENDING_RECEIPT" as const) : ("ERROR" as const),
        errorCode: r.ok ? null : (r.errorCode ?? null),
        errorMessage: r.ok ? null : (r.errorMessage ?? null),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length > 0) await db.insert(pushTickets).values(rows);

  const gone = results.filter((r) => !r.ok && r.errorCode === DEVICE_NOT_REGISTERED);
  await deactivatePushTokens(
    gone.map((r) => tokenByValue.get(r.token)?.id).filter((id): id is string => Boolean(id)),
    DEVICE_NOT_REGISTERED,
  );

  const sent = results.filter((r) => r.ok).length;
  if (sent > 0) return { providerRef: `${provider.name}:${sent}/${tokens.length}` };
  if (gone.length === results.length) {
    throw new ChannelUnavailableError("Every device of this person is no longer registered for push.");
  }
  const codes = [...new Set(results.filter((r) => !r.ok).map((r) => r.errorCode ?? "UnknownError"))].join(", ");
  if (results.some((r) => r.errorCode && TRANSIENT_PUSH_ERRORS.includes(r.errorCode))) {
    throw new PushTransientError(`Push provider asked to retry later (${codes}).`);
  }
  throw new Error(`Push refused by ${provider.name} (${codes}).`);
}

export const pushChannel: ChannelProvider = {
  channel: "PUSH",
  // The switch is a rule (async), checked by isEnabled() before any address lookup.
  isAvailable: () => true,
  isEnabled: isPushEnabled,
  // The devices are looked up when sending; the delivery's address is the person.
  addressFor: (recipient) => (recipient.userId ? `${ADDRESS_PREFIX}${recipient.userId}` : null),
  send: (message) => sendPushForDelivery(message),
};
