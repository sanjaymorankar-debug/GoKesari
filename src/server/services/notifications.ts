/**
 * Notification service (requirement §49) — a multi-channel framework.
 *
 *   notify()  →  in-app inbox row (notifications)
 *             →  one queued delivery per enabled outbound channel
 *                (notification_deliveries) → provider (email live; SMS, push,
 *                WhatsApp plug in through server/notifications/channels.ts)
 *
 * - Templates and categories: server/notifications/templates.ts
 * - Preferences: per user, per category, per channel; security notices are
 *   always sent. No preference row = the template's default.
 * - Delivery: sent the moment notify() is called (just after commit when
 *   called inside a transaction); notification_deliveries is the outbox — a
 *   failed send stays there with its attempt count and is retried with the
 *   configured backoff (notification-retry job) up to `maxAttempts`, then
 *   marked DEAD, audited, and support is alerted in the app (event layer). A
 *   channel with no provider or no address is SKIPPED, not failed. Nothing here is mandatory for a deployment to work:
 *   with no SMTP configured, email deliveries are simply skipped.
 * - notify() never throws — a failed notification must not roll back the
 *   business operation that triggered it — and never sends inside the
 *   caller's transaction: it only queues, and delivery runs after.
 */
import { cache } from "react";
import { and, count, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { conflict, validationFailed } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { ChannelUnavailableError, getChannelProvider } from "@/server/notifications/channels";
import {
  CATEGORIES,
  MANDATORY_CATEGORIES,
  OUTBOUND_CHANNELS,
  categoryOf,
  emailByDefault,
  renderEmail,
  renderTemplate,
  type CategoryKey,
  type Channel,
  type OutboundChannel,
} from "@/server/notifications/templates";
import { NOTIFICATION_TYPES, type NotificationType } from "@/server/notifications/types";
import { db, type DbClient } from "@/server/db";
import {
  notificationDeliveries,
  notificationPreferences,
  notifications,
  users,
  type Notification,
  type NotificationDelivery,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";

export { NOTIFICATION_TYPES, type NotificationType };

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  /** Omit to use the event's template with `vars`. */
  title?: string;
  body?: string;
  /** Values for the template's {{placeholders}}. */
  vars?: Record<string, string | number | null | undefined>;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  /** Extra outbound channels to attempt for this notification (still subject to the user's opt-outs). */
  channels?: Channel[];
  /**
   * When set, the notification is written at most once for this key. Used for
   * things like a single low-balance warning per threshold crossing.
   */
  dedupeKey?: string;
}

/* -------------------------------------------------------------- preferences */

type PrefMap = Map<string, boolean>; // `${category}:${channel}` -> enabled

async function loadPreferences(userId: string, client: DbClient): Promise<PrefMap> {
  const rows = await client.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  return new Map(rows.map((r) => [`${r.category}:${r.channel}`, r.enabled]));
}

function channelEnabled(prefs: PrefMap, category: CategoryKey, channel: Channel, defaultOn: boolean): boolean {
  if (MANDATORY_CATEGORIES.includes(category)) return channel === "IN_APP" || channel === "EMAIL" ? true : defaultOn;
  return prefs.get(`${category}:${channel}`) ?? defaultOn;
}

/* ------------------------------------------------------------------- notify */

/**
 * Writes the in-app notification and queues outbound deliveries. Never
 * throws; a duplicate `dedupeKey` is silently dropped.
 */
export async function notify(input: NotifyInput, client: DbClient = db): Promise<void> {
  try {
    const rendered = input.vars || !input.title || !input.body ? renderTemplate(input.type, input.vars ?? {}) : null;
    const title = input.title ?? rendered?.title;
    const body = input.body ?? rendered?.body;
    if (!title || !body) {
      console.error("[notifications] no title/body and no template for", input.type);
      return;
    }
    const category = categoryOf(input.type);
    const prefs = await loadPreferences(input.userId, client);

    let notificationId: string | null = null;
    if (channelEnabled(prefs, category, "IN_APP", true)) {
      const [row] = await client
        .insert(notifications)
        .values({
          userId: input.userId,
          type: input.type,
          channel: "IN_APP",
          title,
          body,
          actionUrl: input.actionUrl ?? null,
          metadata: input.metadata ?? null,
          dedupeKey: input.dedupeKey ?? null,
          sentAt: new Date(),
        })
        // Relies on the unique index over dedupe_key.
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      // A dropped duplicate suppresses the outbound copies too.
      if (!row && input.dedupeKey) return;
      notificationId = row?.id ?? null;
    }

    // Outbound channels: the template's email default plus anything the caller asked for, minus user opt-outs.
    const wanted = new Set<OutboundChannel>();
    if (emailByDefault(input.type)) wanted.add("EMAIL");
    for (const channel of input.channels ?? []) if (channel !== "IN_APP") wanted.add(channel);
    // A user who switched a category's channel ON gets it for every event in that category.
    for (const channel of OUTBOUND_CHANNELS) if (prefs.get(`${category}:${channel}`) === true) wanted.add(channel);

    const outbound = [...wanted].filter((channel) =>
      channelEnabled(prefs, category, channel, wanted.has(channel)),
    );
    if (outbound.length > 0) {
      const rules = await getRule("notifications");
      const email = renderEmail({ title, body, actionUrl: input.actionUrl, baseUrl: getEnv().AUTH_URL });
      await client.insert(notificationDeliveries).values(
        outbound.map((channel) => ({
          notificationId,
          userId: input.userId,
          type: input.type,
          category,
          channel,
          maxAttempts: rules.maxAttempts,
          subject: email.subject,
          body: email.text,
          html: channel === "EMAIL" ? email.html : null,
          actionUrl: input.actionUrl ?? null,
        })),
      );
      scheduleDelivery(client);
    }
  } catch (error) {
    console.error("[notifications] failed to deliver", input.type, error);
  }
}

/** Convenience for events fully described by their template. */
export function notifyEvent(
  type: NotificationType,
  userId: string,
  vars: Record<string, string | number | null | undefined>,
  extra: Pick<NotifyInput, "actionUrl" | "dedupeKey" | "metadata"> = {},
): Promise<void> {
  return notify({ type, userId, vars, ...extra });
}

/**
 * Deliveries queued inside someone's transaction are only visible once it
 * commits, so a quick timer (and the cron sweep) picks them up afterwards.
 */
function scheduleDelivery(client: DbClient): void {
  const run = () => void deliverPending().catch((error) => console.error("[notifications] delivery run failed", error));
  if (client === db) run();
  else setTimeout(run, 2_000).unref?.();
}

/* ---------------------------------------------------------------- delivery */

function backoffSeconds(schedule: number[], attempt: number): number {
  return schedule[Math.min(attempt - 1, schedule.length - 1)] ?? 60;
}

/**
 * Sends due deliveries: PENDING and FAILED rows whose next attempt time has
 * come. Rows are claimed with SKIP LOCKED so overlapping runs never send the
 * same message twice; a row stuck in SENDING (process died) is re-queued.
 */
export async function deliverPending(options: { limit?: number } = {}): Promise<{
  sent: number;
  failed: number;
  skipped: number;
  dead: number;
}> {
  const rules = await getRule("notifications");
  const limit = options.limit ?? rules.batchSize;
  const tally = { sent: 0, failed: 0, skipped: 0, dead: 0 };

  await db
    .update(notificationDeliveries)
    .set({ status: "FAILED", lastError: "Interrupted while sending", updatedAt: new Date() })
    .where(
      and(
        eq(notificationDeliveries.status, "SENDING"),
        lte(notificationDeliveries.updatedAt, sql`now() - interval '10 minutes'`),
      ),
    );

  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(
        and(
          inArray(notificationDeliveries.status, ["PENDING", "FAILED"]),
          lte(notificationDeliveries.nextAttemptAt, sql`now()`),
        ),
      )
      .orderBy(notificationDeliveries.nextAttemptAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(notificationDeliveries)
      .set({ status: "SENDING", updatedAt: new Date() })
      .where(inArray(notificationDeliveries.id, due.map((d) => d.id)))
      .returning();
  });

  const dead: { delivery: NotificationDelivery; error: string }[] = [];
  for (const delivery of claimed) {
    const outcome = await sendOne(delivery, rules);
    tally[outcome.status] += 1;
    if (outcome.status === "dead") dead.push({ delivery, error: outcome.error });
  }
  if (dead.length > 0 && rules.alertSupportOnDead) await alertSupportOfDead(dead, rules.maxAttempts);
  return tally;
}

/**
 * Event layer: one in-app alert to support per run in which messages were
 * given up on. An alert about an alert is never raised — if the alerts
 * themselves cannot be sent, the audit log still has every DEAD row.
 */
async function alertSupportOfDead(
  dead: { delivery: NotificationDelivery; error: string }[],
  maxAttempts: number,
): Promise<void> {
  const real = dead.filter((d) => d.delivery.type !== NOTIFICATION_TYPES.SUPPORT_NOTIFICATION_DEAD);
  if (real.length === 0) return;
  const latest = real[real.length - 1];
  try {
    const { emitEvent } = await import("@/server/events/emit");
    await emitEvent({
      type: "notification.dead",
      subjectId: latest.delivery.id,
      payload: {
        count: real.length,
        attempts: maxAttempts,
        type: latest.delivery.type,
        channel: latest.delivery.channel,
        error: latest.error,
      },
      idempotencyKey: `notification-dead:${real[0].delivery.id}`,
    });
  } catch (error) {
    console.error("[notifications] could not alert support about dead deliveries", error);
  }
}

type SendOutcome = { status: "sent" | "failed" | "skipped" } | { status: "dead"; error: string };

async function sendOne(
  delivery: NotificationDelivery,
  rules: Awaited<ReturnType<typeof getRule<"notifications">>>,
): Promise<SendOutcome> {
  const finish = (fields: Partial<typeof notificationDeliveries.$inferInsert>) =>
    db
      .update(notificationDeliveries)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(notificationDeliveries.id, delivery.id));

  const provider = getChannelProvider(delivery.channel as OutboundChannel);
  if (!provider || !provider.isAvailable()) {
    await finish({ status: "SKIPPED", lastError: "No provider is configured for this channel." });
    return { status: "skipped" };
  }
  const [user] = await db
    .select({ email: users.email, phoneE164: users.phoneE164 })
    .from(users)
    .where(eq(users.id, delivery.userId));
  const to = user ? provider.addressFor(user) : null;
  if (!to) {
    await finish({ status: "SKIPPED", lastError: "The user has no address for this channel." });
    return { status: "skipped" };
  }

  const attempts = delivery.attempts + 1;
  try {
    const result = await provider.send({
      to,
      subject: delivery.subject,
      text: delivery.body,
      html: delivery.html,
      actionUrl: delivery.actionUrl,
    });
    await finish({
      status: "SENT",
      attempts,
      sentAt: new Date(),
      toAddress: to,
      providerRef: result.providerRef ?? null,
      lastError: null,
    });
    return { status: "sent" };
  } catch (error) {
    if (error instanceof ChannelUnavailableError) {
      await finish({ status: "SKIPPED", attempts, toAddress: to, lastError: error.message });
      return { status: "skipped" };
    }
    const message = error instanceof Error ? error.message.slice(0, 300) : "Delivery failed.";
    if (attempts >= delivery.maxAttempts) {
      await finish({ status: "DEAD", attempts, toAddress: to, lastError: message });
      await recordAudit({
        action: AUDIT_ACTIONS.NOTIFICATION_DELIVERY_DEAD,
        entityType: "notification_delivery",
        entityId: delivery.id,
        newValue: { type: delivery.type, channel: delivery.channel, attempts, error: message },
      });
      return { status: "dead", error: message };
    }
    await finish({
      status: "FAILED",
      attempts,
      toAddress: to,
      lastError: message,
      nextAttemptAt: new Date(Date.now() + backoffSeconds(rules.retryBackoffSeconds, attempts) * 1000),
    });
    return { status: "failed" };
  }
}

/* ----------------------------------------------------- preferences (API) */

export interface PreferenceRow {
  category: CategoryKey;
  label: string;
  description: string;
  mandatory: boolean;
  channels: { channel: Channel; enabled: boolean; available: boolean }[];
}

/** The settings matrix for one user: every category × channel with its effective value. */
export async function getPreferenceMatrix(userId: string): Promise<PreferenceRow[]> {
  const prefs = await loadPreferences(userId, db);
  const channels: Channel[] = ["IN_APP", ...OUTBOUND_CHANNELS];
  return (Object.keys(CATEGORIES) as CategoryKey[]).map((category) => {
    const mandatory = MANDATORY_CATEGORIES.includes(category);
    return {
      category,
      label: CATEGORIES[category].label,
      description: CATEGORIES[category].description,
      mandatory,
      channels: channels.map((channel) => {
        const provider = channel === "IN_APP" ? null : getChannelProvider(channel as OutboundChannel);
        const available = channel === "IN_APP" || Boolean(provider?.isAvailable());
        // Default: in-app on everywhere; email on where events default to it (approximated per category).
        const defaultOn = channel === "IN_APP" || (channel === "EMAIL" && defaultEmailForCategory(category));
        return { channel, available, enabled: channelEnabled(prefs, category, channel, defaultOn) };
      }),
    };
  });
}

function defaultEmailForCategory(category: CategoryKey): boolean {
  return ["ORDERS", "RETURNS", "ACCOUNT_SECURITY", "SHOP"].includes(category);
}

export async function setPreference(
  actor: { id: string; role: UserRole },
  category: CategoryKey,
  channel: Channel,
  enabled: boolean,
): Promise<void> {
  if (!(category in CATEGORIES)) throw validationFailed("Unknown category.");
  if (MANDATORY_CATEGORIES.includes(category) && !enabled) {
    throw validationFailed("Security notices cannot be switched off.");
  }
  await db
    .insert(notificationPreferences)
    .values({ userId: actor.id, category, channel, enabled })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.category, notificationPreferences.channel],
      set: { enabled, updatedAt: new Date() },
    });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.NOTIFICATION_PREFERENCE_CHANGED,
    entityType: "notification_preference",
    entityId: actor.id,
    newValue: { category, channel, enabled },
  });
}

/* ------------------------------------------------------ inbox & operations */

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

async function unreadCountUncached(userId: string): Promise<number> {
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

/** Memoised for one server render (layout, header and board all ask); API routes and actions call straight through. */
export const unreadCount = cache(unreadCountUncached);

export async function markRead(userId: string, notificationId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));
}

export async function markAllRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}

/** Admin view of outbound deliveries (failures first) and the counts behind the dashboard. */
export async function listDeliveries(options: { status?: NotificationDelivery["status"]; limit?: number } = {}) {
  return db
    .select()
    .from(notificationDeliveries)
    .where(options.status ? eq(notificationDeliveries.status, options.status) : undefined)
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));
}

export async function getDeliveryStats(hours = 24) {
  const rows = await db
    .select({ status: notificationDeliveries.status, n: sql<number>`count(*)::int` })
    .from(notificationDeliveries)
    .where(sql`${notificationDeliveries.createdAt} > now() - make_interval(hours => ${hours})`)
    .groupBy(notificationDeliveries.status);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<NotificationDelivery["status"], number>>;
  return {
    sent: byStatus.SENT ?? 0,
    pending: (byStatus.PENDING ?? 0) + (byStatus.SENDING ?? 0),
    failed: byStatus.FAILED ?? 0,
    dead: byStatus.DEAD ?? 0,
    skipped: byStatus.SKIPPED ?? 0,
  };
}

/** Puts a dead or skipped delivery back in the queue (an operator fixed the cause). */
export async function requeueDelivery(deliveryId: string, actor: { id: string; role: UserRole }): Promise<void> {
  const [row] = await db
    .update(notificationDeliveries)
    .set({ status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(and(eq(notificationDeliveries.id, deliveryId), inArray(notificationDeliveries.status, ["DEAD", "SKIPPED", "FAILED"])))
    .returning({ id: notificationDeliveries.id });
  if (!row) throw conflict("That delivery cannot be retried.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.NOTIFICATION_DELIVERY_REQUEUED,
    entityType: "notification_delivery",
    entityId: deliveryId,
  });
}
