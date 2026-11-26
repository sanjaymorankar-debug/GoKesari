/**
 * Rider SOS and emergency contacts (Rider App v2, rule riderSos, OFF by default).
 *
 * The rider presses SOS → one rider_sos_events row (their live delivery, if any, and their
 * position when the phone shared it) → every SUPPORT user (operators and admins) is alerted at
 * once (in-app, push, SMS) with the rider's name, phone, order number and a map link. A rider has
 * at most one OPEN event: pressing again returns it (and refreshes the position) instead of
 * alerting everyone again. Operations acknowledge it on Admin → Rider SOS (the rider is told
 * "Help is on the way") and close it with a note.
 *
 * Notifications are sent after the database commit, never inside db.transaction.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { forbidden, notFound, validationFailed, conflict } from "@/lib/errors";
import { buildSosAlertVars, emergencyContactErrors, sosMapUrl } from "@/lib/rider-safety";
import { db } from "@/server/db";
import { deliveryOrders, deliveryPartners, orders, riderSosEvents, type RiderSosEvent, type UserRole } from "@/server/db/schema";
import { listAudienceUserIds } from "@/server/events/recipients";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getMyActiveDeliveryOrder } from "./delivery-assignment";
import { notify } from "./notifications";
import { getRule } from "./settings";

export interface Actor {
  id: string;
  role: UserRole;
}

export type SosStatus = RiderSosEvent["status"];

export interface SosPosition {
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
}

export interface RiderSosSettings {
  enabled: boolean;
  emergencyNumber: string;
}

export async function getRiderSosSettings(): Promise<RiderSosSettings> {
  const rule = await getRule("riderSos");
  return { enabled: rule.enabled, emergencyNumber: rule.emergencyNumber };
}

async function partnerOf(userId: string) {
  const [partner] = await db
    .select({ id: deliveryPartners.id, fullName: deliveryPartners.fullName, mobile: deliveryPartners.mobile })
    .from(deliveryPartners)
    .where(eq(deliveryPartners.userId, userId));
  return partner ?? null;
}

function cleanPosition(position: SosPosition) {
  const ok = position.latitude != null && position.longitude != null && sosMapUrl(position.latitude, position.longitude) != null;
  return {
    latitude: ok ? position.latitude! : null,
    longitude: ok ? position.longitude! : null,
    accuracyM: ok && position.accuracyM != null && Number.isFinite(position.accuracyM) ? Math.max(0, Math.round(position.accuracyM)) : null,
  };
}

export interface RaiseSosResult {
  id: string;
  status: SosStatus;
  emergencyNumber: string;
  /** True when an OPEN event already existed (operations were not alerted again). */
  alreadyOpen: boolean;
}

/** The rider presses SOS. */
export async function raiseSos(actor: Actor, position: SosPosition): Promise<RaiseSosResult> {
  const settings = await getRiderSosSettings();
  if (!settings.enabled) throw forbidden("SOS is not switched on.");
  const partner = await partnerOf(actor.id);
  if (!partner) throw notFound("Delivery partner profile");

  const pos = cleanPosition(position);
  const active = await getMyActiveDeliveryOrder(actor.id).catch(() => null);
  let orderNumber: string | null = null;
  if (active) {
    const [row] = await db.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, active.orderId));
    orderNumber = row?.orderNumber ?? null;
  }

  const outcome = await db.transaction(async (tx) => {
    // One OPEN event per rider: a double tap (or two phones) waits here and then finds the first.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`rider_sos:${partner.id}`}))`);
    const [open] = await tx
      .select()
      .from(riderSosEvents)
      .where(and(eq(riderSosEvents.deliveryPartnerId, partner.id), eq(riderSosEvents.status, "OPEN")))
      .orderBy(desc(riderSosEvents.createdAt))
      .limit(1);
    if (open) {
      if (pos.latitude != null) {
        await tx
          .update(riderSosEvents)
          .set({ latitude: pos.latitude, longitude: pos.longitude, accuracyM: pos.accuracyM })
          .where(eq(riderSosEvents.id, open.id));
      }
      return { event: open, created: false };
    }
    const [event] = await tx
      .insert(riderSosEvents)
      .values({ deliveryPartnerId: partner.id, deliveryOrderId: active?.id ?? null, ...pos })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RIDER_SOS_RAISED,
        entityType: "rider_sos_event",
        entityId: event.id,
        newValue: { deliveryPartnerId: partner.id, deliveryOrderId: event.deliveryOrderId, located: pos.latitude != null, accuracyM: pos.accuracyM },
      },
      tx,
    );
    return { event, created: true };
  });

  if (outcome.created) {
    // After commit: alert every operator and admin. One failure never stops the others.
    const vars = buildSosAlertVars({ riderName: partner.fullName, mobile: partner.mobile, orderNumber, ...pos });
    const recipients = await listAudienceUserIds("SUPPORT").catch(() => [] as string[]);
    await Promise.allSettled(
      recipients.map((userId) =>
        notify({
          userId,
          type: "delivery.rider_sos_raised",
          vars,
          actionUrl: "/admin/rider-sos",
          channels: ["PUSH", "SMS"],
          mandatory: true,
          dedupeKey: `rider-sos:${outcome.event.id}:${userId}`,
          metadata: { sosEventId: outcome.event.id },
        }),
      ),
    );
  }

  return { id: outcome.event.id, status: outcome.event.status, emergencyNumber: settings.emergencyNumber, alreadyOpen: !outcome.created };
}

export interface MySosStatus {
  enabled: boolean;
  emergencyNumber: string;
  event: { id: string; status: SosStatus; createdAt: string; acknowledgedAt: string | null } | null;
}

/** The rider's latest event that is still OPEN or ACKNOWLEDGED (the app shows "Help is on the way"). */
export async function getMySosStatus(userId: string): Promise<MySosStatus> {
  const settings = await getRiderSosSettings();
  const partner = await partnerOf(userId);
  if (!partner) return { ...settings, event: null };
  const [event] = await db
    .select()
    .from(riderSosEvents)
    .where(and(eq(riderSosEvents.deliveryPartnerId, partner.id), inArray(riderSosEvents.status, ["OPEN", "ACKNOWLEDGED"])))
    .orderBy(desc(riderSosEvents.createdAt))
    .limit(1);
  return {
    ...settings,
    event: event
      ? { id: event.id, status: event.status, createdAt: event.createdAt.toISOString(), acknowledgedAt: event.acknowledgedAt?.toISOString() ?? null }
      : null,
  };
}

/* ------------------------------------------------------------------ admin */

export interface SosAdminRow {
  id: string;
  status: SosStatus;
  createdAt: Date;
  acknowledgedAt: Date | null;
  closedAt: Date | null;
  note: string | null;
  riderName: string;
  riderMobile: string;
  emergencyContactName: string | null;
  emergencyContactMobile: string | null;
  emergencyContactRelation: string | null;
  orderNumber: string | null;
  mapUrl: string | null;
  accuracyM: number | null;
}

export async function listSosEvents(filter: { status?: SosStatus | null; limit?: number } = {}): Promise<SosAdminRow[]> {
  const rows = await db
    .select({
      event: riderSosEvents,
      riderName: deliveryPartners.fullName,
      riderMobile: deliveryPartners.mobile,
      emergencyContactName: deliveryPartners.emergencyContactName,
      emergencyContactMobile: deliveryPartners.emergencyContactMobile,
      emergencyContactRelation: deliveryPartners.emergencyContactRelation,
      orderNumber: orders.orderNumber,
    })
    .from(riderSosEvents)
    .innerJoin(deliveryPartners, eq(deliveryPartners.id, riderSosEvents.deliveryPartnerId))
    .leftJoin(deliveryOrders, eq(deliveryOrders.id, riderSosEvents.deliveryOrderId))
    .leftJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .where(filter.status ? eq(riderSosEvents.status, filter.status) : undefined)
    // Open first, then acknowledged, then closed; newest first within each.
    .orderBy(sql`CASE ${riderSosEvents.status} WHEN 'OPEN' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 ELSE 2 END`, desc(riderSosEvents.createdAt))
    .limit(Math.min(Math.max(filter.limit ?? 200, 1), 500));
  return rows.map((r) => ({
    id: r.event.id,
    status: r.event.status,
    createdAt: r.event.createdAt,
    acknowledgedAt: r.event.acknowledgedAt,
    closedAt: r.event.closedAt,
    note: r.event.note,
    riderName: r.riderName,
    riderMobile: r.riderMobile,
    emergencyContactName: r.emergencyContactName,
    emergencyContactMobile: r.emergencyContactMobile,
    emergencyContactRelation: r.emergencyContactRelation,
    orderNumber: r.orderNumber,
    mapUrl: sosMapUrl(r.event.latitude, r.event.longitude),
    accuracyM: r.event.accuracyM,
  }));
}

async function riderUserIdOf(deliveryPartnerId: string): Promise<string | null> {
  const [row] = await db.select({ userId: deliveryPartners.userId }).from(deliveryPartners).where(eq(deliveryPartners.id, deliveryPartnerId));
  return row?.userId ?? null;
}

/** Operations have seen the SOS: OPEN → ACKNOWLEDGED, and the rider is told help is on the way. */
export async function acknowledgeSos(id: string, actor: Actor): Promise<RiderSosEvent> {
  const now = new Date();
  const event = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(riderSosEvents)
      .set({ status: "ACKNOWLEDGED", acknowledgedBy: actor.id, acknowledgedAt: now })
      .where(and(eq(riderSosEvents.id, id), eq(riderSosEvents.status, "OPEN")))
      .returning();
    if (!row) {
      const [exists] = await tx.select({ status: riderSosEvents.status }).from(riderSosEvents).where(eq(riderSosEvents.id, id));
      if (!exists) throw notFound("SOS");
      throw conflict(`This SOS is already ${exists.status.toLowerCase()}.`);
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RIDER_SOS_ACKNOWLEDGED,
        entityType: "rider_sos_event",
        entityId: row.id,
        previousValue: { status: "OPEN" },
        newValue: { status: "ACKNOWLEDGED" },
      },
      tx,
    );
    return row;
  });

  const riderUserId = await riderUserIdOf(event.deliveryPartnerId);
  if (riderUserId) {
    await notify({
      userId: riderUserId,
      type: "delivery.rider_sos_acknowledged",
      vars: {},
      actionUrl: "/delivery-partner",
      channels: ["PUSH", "SMS"],
      mandatory: true,
      lang: "auto",
      dedupeKey: `rider-sos-ack:${event.id}`,
    });
  }
  return event;
}

/** Operations close the SOS with a note (what happened, what was done). */
export async function closeSos(id: string, note: string, actor: Actor): Promise<RiderSosEvent> {
  const clean = note.trim();
  if (clean.length < 3) throw validationFailed("Write a short note on what happened.", { fields: { note: "Write a short note." } });
  if (clean.length > 2000) throw validationFailed("Keep the note under 2000 characters.", { fields: { note: "Too long." } });
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(riderSosEvents).where(eq(riderSosEvents.id, id)).for("update");
    if (!before) throw notFound("SOS");
    if (before.status === "CLOSED") throw conflict("This SOS is already closed.");
    const [row] = await tx
      .update(riderSosEvents)
      .set({
        status: "CLOSED",
        closedAt: new Date(),
        note: clean,
        // Closing an OPEN event counts as having seen it.
        acknowledgedBy: before.acknowledgedBy ?? actor.id,
        acknowledgedAt: before.acknowledgedAt ?? new Date(),
      })
      .where(eq(riderSosEvents.id, id))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RIDER_SOS_CLOSED,
        entityType: "rider_sos_event",
        entityId: row.id,
        previousValue: { status: before.status },
        newValue: { status: "CLOSED", note: clean },
      },
      tx,
    );
    return row;
  });
}

/* ------------------------------------------------------- emergency contact */

export interface EmergencyContact {
  name: string | null;
  mobile: string | null;
  relation: string | null;
}

export async function getMyEmergencyContact(userId: string): Promise<EmergencyContact | null> {
  const [row] = await db
    .select({
      name: deliveryPartners.emergencyContactName,
      mobile: deliveryPartners.emergencyContactMobile,
      relation: deliveryPartners.emergencyContactRelation,
    })
    .from(deliveryPartners)
    .where(eq(deliveryPartners.userId, userId));
  return row ?? null;
}

export async function updateMyEmergencyContact(
  actor: Actor,
  input: { name: string; mobile: string; relation?: string | null },
): Promise<EmergencyContact> {
  const [partner] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.userId, actor.id));
  if (!partner) throw notFound("Delivery partner profile");
  const errors = emergencyContactErrors(input, partner.mobile);
  if (Object.keys(errors).length) throw validationFailed("Please check the highlighted fields.", { fields: errors });
  const next = { name: input.name.trim(), mobile: input.mobile.trim(), relation: input.relation?.trim() || null };
  await db.transaction(async (tx) => {
    await tx
      .update(deliveryPartners)
      .set({ emergencyContactName: next.name, emergencyContactMobile: next.mobile, emergencyContactRelation: next.relation, updatedAt: new Date() })
      .where(eq(deliveryPartners.id, partner.id));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DELIVERY_PARTNER_PROFILE_UPDATED,
        entityType: "delivery_partner",
        entityId: partner.id,
        previousValue: {
          emergencyContactName: partner.emergencyContactName,
          emergencyContactMobile: partner.emergencyContactMobile,
          emergencyContactRelation: partner.emergencyContactRelation,
        },
        newValue: { emergencyContactName: next.name, emergencyContactMobile: next.mobile, emergencyContactRelation: next.relation },
      },
      tx,
    );
  });
  return next;
}
