/**
 * emitEvent — the event layer's single entry point (docs/event-driven-2026-10).
 *
 * Called by the service that changes state, inside the same transaction as the
 * change, so the request that changed something also:
 *
 *   a) has the status change checked against the one state machine for its
 *      subject (lib/state-machines.ts) — an illegal move throws and rolls the
 *      whole change back;
 *   b) writes a domain_events row (the audit trail of business events);
 *   c) notifies everyone the catalogue (catalog.ts) names for the event, now:
 *      the in-app notification is written in this transaction and each
 *      outbound copy is queued in notification_deliveries and sent right
 *      after commit;
 *   d) leaves a failed send in notification_deliveries (the outbox) with its
 *      attempt count, for the notification-retry job — N attempts, then
 *      support is alerted (notifications.ts).
 *
 * Idempotent: an `idempotencyKey` makes the whole event happen at most once
 * (a sweep that runs twice, a retried request), and every notification
 * carries a dedupe key derived from the event, so nobody is told twice.
 */
import { eq } from "drizzle-orm";

import { invalidTransition } from "@/lib/errors";
import { canMove, type MachineKind, type MachineStatus } from "@/lib/state-machines";
import { db, type DbClient } from "@/server/db";
import { domainEvents, type UserRole } from "@/server/db/schema";
import { notify } from "@/server/services/notifications";
import { EVENTS, type EventMessage, type EventPayload, type EventType } from "./catalog";
import { listAudienceUserIds, type Audience } from "./recipients";

export interface EventActor {
  id: string | null;
  role: UserRole | null;
}

export interface EmitEventInput<T extends EventType> {
  type: T;
  /** What changed. Defaults to the catalogue's subject kind for the event. */
  subjectId: string;
  /** The status move, checked against the subject's state machine when the subject has one. */
  transition?: { from: string | null; to: string } | null;
  orderId?: string | null;
  actor?: EventActor | null;
  payload: EventPayload<T>;
  /** At most one event per key, ever. Leave unset for a plain status change (the row lock already serialises those). */
  idempotencyKey?: string;
}

export interface EmitEventResult {
  eventId: string | null;
  /** True when the idempotency key had already been used: nothing was written or sent. */
  duplicate: boolean;
  /** People notified (in-app rows written). */
  notified: number;
}

const AUDIENCES: readonly string[] = ["SUPPORT", "SUPPORT_LEAD"] satisfies Audience[];
const MACHINES: readonly string[] = ["order", "delivery", "seller_verification", "dispute"] satisfies MachineKind[];

/** Throws the standard 409 when the move is not in the subject's state machine. */
export function assertTransition(kind: string, from: string | null, to: string): void {
  if (!MACHINES.includes(kind)) return;
  const machine = kind as MachineKind;
  if (!canMove(machine, from as MachineStatus<typeof machine> | null, to as MachineStatus<typeof machine>)) {
    throw invalidTransition(from ?? "(new)", to);
  }
}

export async function emitEvent<T extends EventType>(
  input: EmitEventInput<T>,
  client: DbClient = db,
): Promise<EmitEventResult> {
  const definition = EVENTS[input.type];
  if (input.transition) assertTransition(definition.subject, input.transition.from, input.transition.to);

  const [row] = await client
    .insert(domainEvents)
    .values({
      type: input.type,
      subjectType: definition.subject,
      subjectId: input.subjectId,
      orderId: input.orderId ?? null,
      fromStatus: input.transition?.from ?? null,
      toStatus: input.transition?.to ?? null,
      actorId: input.actor?.id ?? null,
      actorRole: input.actor?.role ?? null,
      payload: input.payload as Record<string, unknown>,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: domainEvents.id });
  if (!row) return { eventId: null, duplicate: true, notified: 0 };

  const messages = (definition.messages as (p: EventPayload<T>) => EventMessage[])(input.payload);
  const notified = await deliverMessages(row.id, messages, input.actor?.id ?? null, client);
  if (notified > 0) {
    await client.update(domainEvents).set({ notified }).where(eq(domainEvents.id, row.id));
  }
  return { eventId: row.id, duplicate: false, notified };
}

async function deliverMessages(
  eventId: string,
  messages: EventMessage[],
  actorId: string | null,
  client: DbClient,
): Promise<number> {
  const audienceCache = new Map<string, string[]>();
  const sent = new Set<string>();
  let count = 0;
  for (const message of messages) {
    if (!message.to) continue;
    let userIds: string[];
    if (AUDIENCES.includes(message.to)) {
      const audience = message.to as Audience;
      if (!audienceCache.has(audience)) audienceCache.set(audience, await listAudienceUserIds(audience, client));
      userIds = audienceCache.get(audience)!;
    } else {
      userIds = [message.to];
    }
    for (const userId of userIds) {
      if (userId === actorId && !message.includeActor) continue;
      // One notification per person per event: a shop owner who is also an operator hears once.
      if (sent.has(userId)) continue;
      sent.add(userId);
      await notify(
        {
          userId,
          type: message.type,
          title: message.title,
          body: message.body,
          vars: message.vars,
          actionUrl: message.actionUrl,
          channels: message.channels,
          metadata: { eventId },
          dedupeKey: `evt:${message.dedupe ?? eventId}:${message.type}:${userId}`,
        },
        client,
      );
      count += 1;
    }
  }
  return count;
}
