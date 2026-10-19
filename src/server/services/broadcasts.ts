/**
 * Broadcast announcements (F3.3.2 — owner request). An admin or operator
 * (BROADCAST_MANAGE) composes a title, message, optional image and link, picks
 * the audience (customers / shop owners / riders, optionally by city or PIN),
 * and sends now, schedules, or keeps a draft. Rule `broadcasts`.
 *
 * Sending is chunked so a large audience never times out a request:
 *
 *   "Send now"     status SENDING, then up to `immediateChunks` chunks in the
 *                  request itself (most broadcasts finish right there)
 *   cron           /api/cron/broadcast-dispatch (every minute): starts due
 *                  scheduled broadcasts, continues SENDING ones up to
 *                  `dispatchChunksPerRun` chunks, expires the ones past expiry
 *
 * A chunk is `chunkSize` people in user-id order after the stored cursor,
 * written in one transaction: a broadcast_recipients row per person (unique
 * per broadcast — a re-run never sends twice) and an in-app notification
 * through the notification service (type broadcast.announcement, category
 * ANNOUNCEMENTS), which adds push and email by each person's settings. A
 * lease stops two dispatchers working the same broadcast at once. Every send
 * is audited; the sender is told when it finishes (event broadcast.finished).
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import {
  addresses,
  broadcastRecipients,
  broadcasts,
  deliveryPartners,
  notifications,
  shops,
  userRoleGrants,
  users,
  type Broadcast,
  type BroadcastAudience,
  type UserRole,
} from "@/server/db/schema";
import { sellerDb } from "@/server/db/split/clients";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { deliverPending, NOTIFICATION_TYPES, notify } from "./notifications";
import { getRule } from "./settings";

export type BroadcastActor = { id: string; role: UserRole };
export const AUDIENCE_ROLES = ["CUSTOMER", "SHOP_OWNER", "DELIVERY_PARTNER"] as const;
export type AudienceRole = (typeof AUDIENCE_ROLES)[number];

const LEASE_MS = 2 * 60_000;
const PINCODE = /^[1-9][0-9]{5}$/;

/* ------------------------------------------------------------- validation */

/** An in-site path ("/offers") or an https URL — nothing else becomes a link. */
const linkSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => (v.startsWith("/") && !v.startsWith("//") && !v.includes("\\")) || /^https:\/\/[^\s]+$/i.test(v), {
    message: "Use a page on this site (starting with /) or an https:// link.",
  });

const imageSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^\/api\/images\/[0-9a-f-]{36}$/i.test(v) || /^https:\/\/[^\s"'<>]+$/i.test(v), {
    message: "Upload an image or give an https:// image link.",
  });

export const audienceSchema = z.object({
  roles: z.array(z.enum(AUDIENCE_ROLES)).min(1, "Choose who receives it.").max(3),
  cities: z.array(z.string().trim().min(2).max(60)).max(50).optional(),
  pincodes: z.array(z.string().trim().regex(PINCODE, "PIN codes have 6 digits.")).max(200).optional(),
});

export const broadcastInputSchema = z.object({
  title: z.string().trim().min(3, "Give it a title.").max(80),
  message: z.string().trim().min(3, "Write the message.").max(500),
  imageUrl: imageSchema.nullish(),
  linkUrl: linkSchema.nullish(),
  audience: audienceSchema,
  scheduleAt: z.coerce.date().nullish(),
  expiresAt: z.coerce.date().nullish(),
});
export type BroadcastInput = z.input<typeof broadcastInputSchema>;

export function normaliseAudience(raw: z.infer<typeof audienceSchema>): BroadcastAudience {
  const cities = [...new Set((raw.cities ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean))];
  const pincodes = [...new Set((raw.pincodes ?? []).map((p) => p.trim()))];
  return {
    roles: [...new Set(raw.roles)],
    ...(cities.length ? { cities } : {}),
    ...(pincodes.length ? { pincodes } : {}),
  };
}

async function assertCanManage(actor: BroadcastActor): Promise<void> {
  if (!can(actor.role, PERMISSIONS.BROADCAST_MANAGE)) throw forbidden("You cannot send broadcasts.");
  if (!(await getRule("broadcasts")).enabled) throw forbidden("Broadcasts are switched off (rule broadcasts).");
}

function checkTimes(scheduleAt: Date | null, expiresAt: Date | null, now = new Date()): void {
  if (scheduleAt && scheduleAt.getTime() <= now.getTime()) throw validationFailed("Pick a time in the future to schedule it.");
  if (expiresAt && expiresAt.getTime() <= (scheduleAt ?? now).getTime()) {
    throw validationFailed("The expiry must be after the time it is sent.");
  }
}

/* --------------------------------------------------------------- audience */

const ROLE_SETS: Record<AudienceRole, UserRole[]> = {
  // A society admin is a resident who shops (permissions.ts).
  CUSTOMER: ["CUSTOMER", "SOCIETY_ADMIN"],
  SHOP_OWNER: ["SHOP_OWNER"],
  DELIVERY_PARTNER: ["DELIVERY_PARTNER"],
};

function holdsRole(role: AudienceRole): SQL {
  const roles = ROLE_SETS[role];
  const list = sql.join(roles.map((r) => sql`${r}`), sql`, `);
  const byRole = sql`(${users.role} in (${list}) or exists (select 1 from ${userRoleGrants} g where g.user_id = ${users.id} and g.role in (${list}) and g.status = 'ACTIVE'))`;
  if (role !== "DELIVERY_PARTNER") return byRole;
  return sql`(${byRole} or exists (select 1 from ${deliveryPartners} dp where dp.user_id = ${users.id} and dp.deleted_at is null))`;
}

function addressIn(cities: string[], pincodes: string[]): SQL {
  const parts: SQL[] = [];
  if (cities.length) parts.push(sql`lower(trim(a.city)) in (${sql.join(cities.map((c) => sql`${c}`), sql`, `)})`);
  if (pincodes.length) parts.push(sql`a.pincode in (${sql.join(pincodes.map((p) => sql`${p}`), sql`, `)})`);
  return sql`exists (select 1 from ${addresses} a where a.user_id = ${users.id} and a.deleted_at is null and (${sql.join(parts, sql` or `)}))`;
}

/** Owners of shops in those cities / PIN codes — shops live in the seller database, so this is a separate read. */
async function shopOwnersIn(cities: string[], pincodes: string[]): Promise<string[]> {
  const parts: SQL[] = [];
  if (cities.length) parts.push(sql`lower(trim(${shops.city})) in (${sql.join(cities.map((c) => sql`${c}`), sql`, `)})`);
  if (pincodes.length) parts.push(inArray(shops.pincode, pincodes));
  const rows = await sellerDb()
    .selectDistinct({ ownerId: shops.ownerId })
    .from(shops)
    .where(or(...parts));
  return rows.map((r) => r.ownerId);
}

/**
 * The WHERE clause for everyone a broadcast goes to: active accounts holding
 * one of the roles, and — when cities / PIN codes are given — whose saved
 * address (customers, riders) or shop (owners) is there.
 */
export async function audienceWhere(audience: BroadcastAudience): Promise<SQL> {
  const cities = audience.cities ?? [];
  const pincodes = audience.pincodes ?? [];
  const located = cities.length > 0 || pincodes.length > 0;
  const clauses: SQL[] = [];
  for (const role of audience.roles) {
    if (!located) {
      clauses.push(holdsRole(role));
    } else if (role === "SHOP_OWNER") {
      const owners = await shopOwnersIn(cities, pincodes);
      clauses.push(owners.length ? sql`(${holdsRole(role)} and ${inArray(users.id, owners)})` : sql`false`);
    } else {
      clauses.push(sql`(${holdsRole(role)} and ${addressIn(cities, pincodes)})`);
    }
  }
  return and(
    eq(users.status, "ACTIVE"),
    isNull(users.deletedAt),
    clauses.length ? sql`(${sql.join(clauses, sql` or `)})` : sql`false`,
  )!;
}

export async function estimateAudience(actor: BroadcastActor, rawAudience: unknown): Promise<number> {
  await assertCanManage(actor);
  const audience = normaliseAudience(audienceSchema.parse(rawAudience));
  return countAudience(audience);
}

async function countAudience(audience: BroadcastAudience): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(await audienceWhere(audience));
  return row?.n ?? 0;
}

/* ---------------------------------------------------------------- compose */

export interface BroadcastView extends Broadcast {
  readCount: number;
}

export async function getBroadcast(id: string): Promise<BroadcastView> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Broadcast");
  const rows = await db.select().from(broadcasts).where(eq(broadcasts.id, id));
  if (rows.length === 0) throw notFound("Broadcast");
  const [row] = await attachReadCounts(rows);
  return row;
}

export async function listBroadcasts(options: { status?: Broadcast["status"]; limit?: number } = {}): Promise<BroadcastView[]> {
  const rows = await db
    .select()
    .from(broadcasts)
    .where(options.status ? eq(broadcasts.status, options.status) : undefined)
    .orderBy(desc(broadcasts.createdAt))
    .limit(Math.min(options.limit ?? 50, 200));
  return attachReadCounts(rows);
}

async function attachReadCounts(rows: Broadcast[]): Promise<BroadcastView[]> {
  if (rows.length === 0) return [];
  const counts = await db
    .select({ broadcastId: broadcastRecipients.broadcastId, n: sql<number>`count(*)::int` })
    .from(broadcastRecipients)
    .innerJoin(notifications, eq(notifications.id, broadcastRecipients.notificationId))
    .where(and(inArray(broadcastRecipients.broadcastId, rows.map((r) => r.id)), sql`${notifications.readAt} is not null`))
    .groupBy(broadcastRecipients.broadcastId);
  const byId = new Map(counts.map((c) => [c.broadcastId, c.n]));
  return rows.map((r) => ({ ...r, readCount: byId.get(r.id) ?? 0 }));
}

export type BroadcastAction = "draft" | "schedule" | "send";

/** Saves a new broadcast as a draft, then schedules or sends it when asked. */
export async function createBroadcast(
  actor: BroadcastActor,
  raw: unknown,
  action: BroadcastAction = "draft",
): Promise<BroadcastView> {
  await assertCanManage(actor);
  const input = broadcastInputSchema.parse(raw);
  const scheduleAt = input.scheduleAt ?? null;
  const expiresAt = input.expiresAt ?? null;
  if (action === "schedule" && !scheduleAt) throw validationFailed("Pick when to send it.");
  checkTimes(action === "schedule" ? scheduleAt : null, expiresAt);
  const [row] = await db
    .insert(broadcasts)
    .values({
      title: input.title,
      message: input.message,
      imageUrl: input.imageUrl ?? null,
      linkUrl: input.linkUrl ?? null,
      audience: normaliseAudience(input.audience),
      scheduleAt,
      expiresAt,
      createdBy: actor.id,
    })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.BROADCAST_SAVED,
    entityType: "broadcast",
    entityId: row.id,
    newValue: { title: row.title, audience: row.audience, scheduleAt, expiresAt },
  });
  if (action === "schedule") return scheduleBroadcast(actor, row.id, scheduleAt!);
  if (action === "send") return sendBroadcastNow(actor, row.id);
  return getBroadcast(row.id);
}

/** Changes a draft or a scheduled broadcast (a scheduled one stays scheduled for its time). */
export async function updateBroadcast(actor: BroadcastActor, id: string, raw: unknown): Promise<BroadcastView> {
  await assertCanManage(actor);
  const current = await getBroadcast(id);
  if (current.status !== "DRAFT" && current.status !== "SCHEDULED") throw conflict("Only a draft or a scheduled broadcast can be changed.");
  const input = broadcastInputSchema.parse(raw);
  const scheduleAt = current.status === "SCHEDULED" ? (input.scheduleAt ?? current.scheduleAt) : (input.scheduleAt ?? null);
  const expiresAt = input.expiresAt ?? null;
  checkTimes(current.status === "SCHEDULED" ? scheduleAt : null, expiresAt);
  const [row] = await db
    .update(broadcasts)
    .set({
      title: input.title,
      message: input.message,
      imageUrl: input.imageUrl ?? null,
      linkUrl: input.linkUrl ?? null,
      audience: normaliseAudience(input.audience),
      scheduleAt,
      expiresAt,
      updatedAt: new Date(),
    })
    .where(and(eq(broadcasts.id, id), inArray(broadcasts.status, ["DRAFT", "SCHEDULED"])))
    .returning();
  if (!row) throw conflict("This broadcast has already started sending.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.BROADCAST_SAVED,
    entityType: "broadcast",
    entityId: id,
    previousValue: { title: current.title, audience: current.audience, scheduleAt: current.scheduleAt, expiresAt: current.expiresAt },
    newValue: { title: row.title, audience: row.audience, scheduleAt, expiresAt },
  });
  return getBroadcast(id);
}

export async function scheduleBroadcast(actor: BroadcastActor, id: string, scheduleAt: Date): Promise<BroadcastView> {
  await assertCanManage(actor);
  const current = await getBroadcast(id);
  checkTimes(scheduleAt, current.expiresAt);
  const [row] = await db
    .update(broadcasts)
    .set({ status: "SCHEDULED", scheduleAt, sentBy: actor.id, updatedAt: new Date() })
    .where(and(eq(broadcasts.id, id), inArray(broadcasts.status, ["DRAFT", "SCHEDULED"])))
    .returning();
  if (!row) throw conflict("Only a draft can be scheduled.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.BROADCAST_SCHEDULED,
    entityType: "broadcast",
    entityId: id,
    previousValue: { status: current.status },
    newValue: { status: "SCHEDULED", scheduleAt },
  });
  return getBroadcast(id);
}

/** "Send now": starts sending and writes the first chunks in this request; the dispatcher writes the rest. */
export async function sendBroadcastNow(
  actor: BroadcastActor,
  id: string,
  options: { deliverNow?: boolean } = {},
): Promise<BroadcastView> {
  await assertCanManage(actor);
  const current = await getBroadcast(id);
  if (current.status !== "DRAFT" && current.status !== "SCHEDULED") {
    throw conflict(current.status === "SENDING" || current.status === "SENT" ? "This broadcast has already been sent." : "This broadcast can no longer be sent.");
  }
  const started = await startSending(current, actor.id, actor.role, ["DRAFT", "SCHEDULED"]);
  if (!started) throw conflict("This broadcast has already been sent.");
  const rules = await getRule("broadcasts");
  if (rules.immediateChunks > 0) await workBroadcast(id, rules.immediateChunks, options);
  return getBroadcast(id);
}

export async function cancelBroadcast(actor: BroadcastActor, id: string): Promise<BroadcastView> {
  await assertCanManage(actor);
  const current = await getBroadcast(id);
  const now = new Date();
  const [row] = await db
    .update(broadcasts)
    .set({ status: "CANCELLED", cancelledAt: now, cancelledBy: actor.id, leaseUntil: null, updatedAt: now })
    .where(and(eq(broadcasts.id, id), inArray(broadcasts.status, ["DRAFT", "SCHEDULED", "SENDING"])))
    .returning();
  if (!row) throw conflict("Only a draft, scheduled or sending broadcast can be cancelled.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.BROADCAST_CANCELLED,
    entityType: "broadcast",
    entityId: id,
    previousValue: { status: current.status },
    newValue: { status: "CANCELLED", recipientCount: row.recipientCount },
  });
  return getBroadcast(id);
}

/* ---------------------------------------------------------------- sending */

/** Moves a broadcast to SENDING (from the given statuses), filling the default expiry and the audience estimate. */
async function startSending(
  current: Broadcast,
  actorId: string | null,
  actorRole: UserRole | null,
  from: Broadcast["status"][],
): Promise<boolean> {
  const rules = await getRule("broadcasts");
  const now = new Date();
  const expiresAt =
    current.expiresAt ?? (rules.defaultExpiryDays > 0 ? new Date(now.getTime() + rules.defaultExpiryDays * 86_400_000) : null);
  const estimate = await countAudience(current.audience);
  const [row] = await db
    .update(broadcasts)
    .set({
      status: "SENDING",
      startedAt: now,
      sentBy: actorId ?? current.sentBy ?? current.createdBy,
      expiresAt,
      audienceEstimate: estimate,
      updatedAt: now,
    })
    .where(and(eq(broadcasts.id, current.id), inArray(broadcasts.status, from)))
    .returning({ id: broadcasts.id });
  if (!row) return false;
  await recordAudit({
    actorId,
    actorRole,
    action: AUDIT_ACTIONS.BROADCAST_SEND_STARTED,
    entityType: "broadcast",
    entityId: current.id,
    previousValue: { status: current.status },
    newValue: { status: "SENDING", audienceEstimate: estimate, expiresAt, scheduled: current.status === "SCHEDULED" },
  });
  return true;
}

async function claim(id: string): Promise<Broadcast | null> {
  const now = new Date();
  const [row] = await db
    .update(broadcasts)
    .set({ leaseUntil: new Date(now.getTime() + LEASE_MS) })
    .where(
      and(
        eq(broadcasts.id, id),
        eq(broadcasts.status, "SENDING"),
        or(isNull(broadcasts.leaseUntil), lt(broadcasts.leaseUntil, now)),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Writes up to `maxChunks` chunks of one SENDING broadcast. Returns the
 * number of people newly reached. Safe to run twice at once (lease) and to
 * re-run after a crash (cursor + unique recipients + notification dedupe key).
 */
export async function workBroadcast(
  id: string,
  maxChunks: number,
  options: { deliverNow?: boolean } = {},
): Promise<{ written: number; chunks: number; finished: boolean }> {
  const claimed = await claim(id);
  if (!claimed) return { written: 0, chunks: 0, finished: false };
  const rules = await getRule("broadcasts");
  const where = await audienceWhere(claimed.audience);
  let cursor = claimed.cursorUserId;
  let written = 0;
  let chunks = 0;
  let finished = false;
  try {
    while (chunks < maxChunks) {
      // A cancel (or expiry) from another request stops the next chunk.
      const [live] = await db.select({ status: broadcasts.status }).from(broadcasts).where(eq(broadcasts.id, id));
      if (live?.status !== "SENDING") break;
      const ids = (
        await db
          .select({ id: users.id })
          .from(users)
          .where(cursor ? and(where, gt(users.id, cursor)) : where)
          .orderBy(asc(users.id))
          .limit(rules.chunkSize)
      ).map((r) => r.id);
      chunks += 1;
      if (ids.length > 0) {
        written += await writeChunk(claimed, ids);
        cursor = ids[ids.length - 1];
        if (options.deliverNow !== false) void deliverPending({ limit: rules.chunkSize * 2 }).catch(() => {});
      }
      if (ids.length < rules.chunkSize) {
        finished = await finishBroadcast(claimed);
        break;
      }
    }
  } catch (error) {
    await db
      .update(broadcasts)
      .set({ lastError: error instanceof Error ? error.message.slice(0, 300) : "Sending failed.", updatedAt: new Date() })
      .where(eq(broadcasts.id, id));
    console.error("[broadcasts] chunk failed", id, error);
  } finally {
    await db.update(broadcasts).set({ leaseUntil: null }).where(eq(broadcasts.id, id));
  }
  return { written, chunks, finished };
}

async function writeChunk(b: Broadcast, userIds: string[]): Promise<number> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(broadcastRecipients)
      .values(userIds.map((userId) => ({ broadcastId: b.id, userId })))
      .onConflictDoNothing()
      .returning({ userId: broadcastRecipients.userId });
    for (const { userId } of inserted) {
      await notify(
        {
          userId,
          type: NOTIFICATION_TYPES.BROADCAST,
          title: b.title,
          body: b.message,
          actionUrl: b.linkUrl ?? undefined,
          metadata: {
            broadcastId: b.id,
            ...(b.imageUrl ? { imageUrl: b.imageUrl } : {}),
            ...(b.expiresAt ? { expiresAt: b.expiresAt.toISOString() } : {}),
          },
          dedupeKey: `broadcast:${b.id}:${userId}`,
          deferDelivery: true,
        },
        tx,
      );
    }
    if (inserted.length > 0) {
      await tx.execute(sql`
        UPDATE broadcast_recipients r SET notification_id = n.id
          FROM notifications n
         WHERE r.broadcast_id = ${b.id}
           AND r.notification_id IS NULL
           AND n.dedupe_key = 'broadcast:' || ${b.id}::text || ':' || r.user_id::text
           AND r.user_id IN (${sql.join(inserted.map((r) => sql`${r.userId}::uuid`), sql`, `)})
      `);
    }
    await tx
      .update(broadcasts)
      .set({
        cursorUserId: userIds[userIds.length - 1],
        recipientCount: sql`${broadcasts.recipientCount} + ${inserted.length}`,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(broadcasts.id, b.id));
    return inserted.length;
  });
}

async function finishBroadcast(b: Broadcast): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .update(broadcasts)
    .set({ status: "SENT", finishedAt: now, updatedAt: now })
    .where(and(eq(broadcasts.id, b.id), eq(broadcasts.status, "SENDING")))
    .returning();
  if (!row) return false;
  await recordAudit({
    actorId: row.sentBy,
    action: AUDIT_ACTIONS.BROADCAST_SENT,
    entityType: "broadcast",
    entityId: b.id,
    previousValue: { status: "SENDING" },
    newValue: { status: "SENT", recipientCount: row.recipientCount, audienceEstimate: row.audienceEstimate },
  });
  try {
    const { emitEvent } = await import("@/server/events/emit");
    await emitEvent({
      type: "broadcast.finished",
      subjectId: b.id,
      payload: { broadcastId: b.id, title: row.title, recipients: row.recipientCount, sentBy: row.sentBy },
      idempotencyKey: `broadcast-finished:${b.id}`,
    });
  } catch (error) {
    console.error("[broadcasts] could not tell the sender", error);
  }
  return true;
}

/**
 * The periodic job (cron broadcast-dispatch): expire, start due scheduled
 * broadcasts, then continue every SENDING one within the chunk budget.
 */
export async function dispatchBroadcasts(
  options: { now?: Date; maxChunks?: number; deliverNow?: boolean } = {},
): Promise<{ expired: number; started: number; written: number; finished: number }> {
  const now = options.now ?? new Date();
  const rules = await getRule("broadcasts");
  const tally = { expired: 0, started: 0, written: 0, finished: 0 };

  const expired = await db
    .update(broadcasts)
    .set({ status: "EXPIRED", leaseUntil: null, updatedAt: now })
    .where(and(inArray(broadcasts.status, ["SCHEDULED", "SENDING", "SENT"]), lte(broadcasts.expiresAt, now)))
    .returning({ id: broadcasts.id, recipientCount: broadcasts.recipientCount });
  for (const row of expired) {
    tally.expired += 1;
    await recordAudit({
      action: AUDIT_ACTIONS.BROADCAST_EXPIRED,
      entityType: "broadcast",
      entityId: row.id,
      newValue: { status: "EXPIRED", recipientCount: row.recipientCount },
    });
  }
  if (!rules.enabled) return tally;

  const due = await db
    .select()
    .from(broadcasts)
    .where(and(eq(broadcasts.status, "SCHEDULED"), lte(broadcasts.scheduleAt, now)))
    .orderBy(asc(broadcasts.scheduleAt))
    .limit(50);
  for (const b of due) {
    if (await startSending(b, b.sentBy ?? b.createdBy, null, ["SCHEDULED"])) tally.started += 1;
  }

  let budget = options.maxChunks ?? rules.dispatchChunksPerRun;
  const sending = await db
    .select({ id: broadcasts.id })
    .from(broadcasts)
    .where(eq(broadcasts.status, "SENDING"))
    .orderBy(asc(broadcasts.startedAt));
  for (const { id } of sending) {
    if (budget <= 0) break;
    const result = await workBroadcast(id, budget, { deliverNow: options.deliverNow });
    budget -= Math.max(result.chunks, 1);
    tally.written += result.written;
    if (result.finished) tally.finished += 1;
  }
  return tally;
}
