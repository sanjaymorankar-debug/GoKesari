/**
 * GoKesari Health: events (docs/health/README.md "Events and real time").
 *
 * Every health state change calls publishHealthEvent(): one row in health.events (the outbox — audit,
 * replay, reports; never clinical text) and an immediate push to the people concerned over the live
 * stream (/api/health/stream, server-sent events). Browsers subscribe per user and per practice / store
 * they work for, so a doctor's Today screen updates within a second of a booking, cancellation or
 * check-in, without polling.
 *
 * The bus is in-process: the site runs as one Node process (VPS, gk-deploy). A second process would
 * need Postgres LISTEN/NOTIFY behind the same subscribe() — see DECISIONS.md H-06.
 */
import { db, type DbClient } from "@/server/db";
import { healthEvents } from "@/server/db/schema";

export const HEALTH_EVENT_NAMES = [
  "appointment.booked",
  "appointment.rescheduled",
  "appointment.cancelled",
  "appointment.checked_in",
  "appointment.completed",
  "appointment.no_show",
  "appointment.changed",
  "queue.updated",
  "consultation.started",
  "prescription.issued",
  "prescription.amended",
  "suggestion.created",
  "suggestion.booked",
  "referral.created",
  "referral.accepted",
  "consent.granted",
  "consent.revoked",
  "record.accessed",
  "record.added",
  "rx.forwarded",
  "rx.quoted",
  "rx.declined",
  "rx.expired",
  "rx.approved",
  "rx.cancelled",
  "order.ready_for_pickup",
  "order.out_for_delivery",
  "order.completed",
  "care_booking.created",
  "care_booking.accepted",
  "care_booking.declined",
  "care_booking.provider_on_the_way",
  "care_booking.checked_in",
  "care_booking.checked_out",
  "care_booking.completed",
  "care_booking.sos",
  "rental.started",
  "rental.due_soon",
  "rental.extended",
  "rental.return_scheduled",
  "rental.returned",
  "rental.deposit_refunded",
  "rental.changed",
  "prime.subscribed",
  "prime.renewal_due",
  "prime.expired",
  "call.missed",
  "provider.verification_pending",
  "provider.verified",
  "provider.rejected",
] as const;
export type HealthEventName = (typeof HEALTH_EVENT_NAMES)[number];

export interface HealthLiveEvent {
  id: number;
  name: HealthEventName;
  shopId: string | null;
  subjectId: string | null;
  payload: Record<string, unknown>;
  at: string;
}

type Listener = (event: HealthLiveEvent) => void;

interface Bus {
  listeners: Map<string, Set<Listener>>;
}

const globalForBus = globalThis as unknown as { __gkHealthBus?: Bus };
const bus: Bus = (globalForBus.__gkHealthBus ??= { listeners: new Map() });

const userKey = (id: string) => `user:${id}`;
const shopKey = (id: string) => `shop:${id}`;

/** Subscribes a live-stream connection. Returns the unsubscribe function. */
export function subscribeHealth(keys: { userId: string; shopIds: readonly string[] }, listener: Listener): () => void {
  const all = [userKey(keys.userId), ...keys.shopIds.map(shopKey)];
  for (const k of all) {
    let set = bus.listeners.get(k);
    if (!set) bus.listeners.set(k, (set = new Set()));
    set.add(listener);
  }
  return () => {
    for (const k of all) {
      const set = bus.listeners.get(k);
      set?.delete(listener);
      if (set && !set.size) bus.listeners.delete(k);
    }
  };
}

/** Number of open live connections (admin health check). */
export function liveConnectionCount(): number {
  const seen = new Set<Listener>();
  for (const set of bus.listeners.values()) for (const l of set) seen.add(l);
  return seen.size;
}

function deliver(event: HealthLiveEvent, userIds: readonly string[]): void {
  const sent = new Set<Listener>();
  const keys = [...userIds.map(userKey), ...(event.shopId ? [shopKey(event.shopId)] : [])];
  for (const k of keys) {
    for (const listener of bus.listeners.get(k) ?? []) {
      if (sent.has(listener)) continue;
      sent.add(listener);
      try {
        listener(event);
      } catch (error) {
        console.error("[health] live listener failed", error);
      }
    }
  }
}

export interface PublishInput {
  name: HealthEventName;
  /** People told directly (the patient's account holder, the doctor, the store owner …). */
  userIds?: readonly (string | null | undefined)[];
  /** Everyone working for this practice / store gets it (their live screens refresh). */
  shopId?: string | null;
  subjectId?: string | null;
  /** Ids and statuses only — never clinical text (the outbox is readable by operations). */
  payload?: Record<string, unknown>;
}

/**
 * Records the event and pushes it live. Inside a transaction (client ≠ db) the push waits a moment so
 * the change is committed before screens reload; outside one it goes at once. Never throws.
 */
export async function publishHealthEvent(input: PublishInput, client: DbClient = db): Promise<void> {
  try {
    const userIds = [...new Set(input.userIds?.filter((v): v is string => Boolean(v)) ?? [])];
    const [row] = await client
      .insert(healthEvents)
      .values({ name: input.name, userIds, shopId: input.shopId ?? null, subjectId: input.subjectId ?? null, payload: input.payload ?? {} })
      .returning({ id: healthEvents.id, createdAt: healthEvents.createdAt });
    const event: HealthLiveEvent = { id: row.id, name: input.name, shopId: input.shopId ?? null, subjectId: input.subjectId ?? null, payload: input.payload ?? {}, at: row.createdAt.toISOString() };
    if (client === db) deliver(event, userIds);
    else setTimeout(() => deliver(event, userIds), 400).unref?.();
  } catch (error) {
    console.error("[health] event failed", input.name, error);
  }
}

/** Live push only (no outbox row) — for consult-booking changes, which keep their own event table. */
export function pushLiveOnly(input: { name: HealthEventName; shopId?: string | null; userIds?: readonly (string | null | undefined)[]; subjectId?: string | null; payload?: Record<string, unknown>; delayMs?: number }): void {
  const userIds = [...new Set(input.userIds?.filter((v): v is string => Boolean(v)) ?? [])];
  const event: HealthLiveEvent = { id: 0, name: input.name, shopId: input.shopId ?? null, subjectId: input.subjectId ?? null, payload: input.payload ?? {}, at: new Date().toISOString() };
  const run = () => deliver(event, userIds);
  if (input.delayMs) setTimeout(run, input.delayMs).unref?.();
  else run();
}
