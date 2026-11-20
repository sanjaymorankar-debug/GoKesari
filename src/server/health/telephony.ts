/**
 * GoKesari Health Prime: virtual phone numbers with call tracking (owner brief §5).
 *
 * A Prime clinic / provider / store gets a virtual number shown on its public profile; calls are
 * forwarded to the shop's own phone and the telephony provider reports each call to
 * /api/health/telephony/webhook. Behind the TelephonyProvider interface, chosen by rule
 * health.telephonyProvider:
 *   - mock        numbers "+91 80 4xxx xxxx" from a deterministic counter (health.counters
 *                 "HEALTH-VNUM"); nothing leaves the server — the default until an account exists
 *   - exotel      TODO: not configured (throws)
 *   - knowlarity  TODO: not configured (throws)
 *
 * The provider call is an external side effect: never made inside a database transaction.
 * Webhook calls are signed: HMAC-SHA256 of the raw body with HEALTH_TELEPHONY_WEBHOOK_SECRET in the
 * x-gokesari-signature header (hex, optionally "sha256=" prefixed). Without a secret the webhook is
 * refused, except with the mock provider outside production (local testing).
 *
 * Callers' numbers are stored masked (last 4 digits only).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { istDateKey } from "@/lib/consult/time";
import { db, type DbClient } from "@/server/db";
import { healthCallLogs, healthVirtualNumbers, shops, users, type HealthCallLog, type HealthVirtualNumber } from "@/server/db/schema";
import { notify, NOTIFICATION_TYPES } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { firmUserIds } from "./access";
import { publishHealthEvent } from "./events";
import { nextNumber } from "./timeline";

export interface TelephonyProvider {
  name: "mock" | "exotel" | "knowlarity";
  assignNumber(shopId: string, forwardTo: string): Promise<{ number: string; providerRef: string }>;
  release(providerRef: string): Promise<void>;
}

/** "+91 80 4000 0001" for counter 1 — deterministic, unique while the counter lives. */
export function mockNumberFor(n: number): string {
  const digits = String(n % 10_000_000).padStart(7, "0");
  return `+91 80 4${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export const mockTelephony: TelephonyProvider = {
  name: "mock",
  async assignNumber() {
    const n = await nextNumber(db, "HEALTH-VNUM");
    return { number: mockNumberFor(n), providerRef: `mock:${n}` };
  },
  async release() {
    /* nothing to release at a mock provider */
  },
};

// TODO(health-telephony): Exotel ExoPhone allocation + call-flow forwarding + status callback to the webhook.
export const exotelTelephony: TelephonyProvider = {
  name: "exotel",
  async assignNumber() {
    throw new Error("Exotel telephony is not configured yet (TODO: account SID, API token, ExoPhone pool).");
  },
  async release() {
    throw new Error("Exotel telephony is not configured yet.");
  },
};

// TODO(health-telephony): Knowlarity SuperReceptionist number + forwarding + call-log push to the webhook.
export const knowlarityTelephony: TelephonyProvider = {
  name: "knowlarity",
  async assignNumber() {
    throw new Error("Knowlarity telephony is not configured yet (TODO: API key, SR number pool).");
  },
  async release() {
    throw new Error("Knowlarity telephony is not configured yet.");
  },
};

export async function telephonyProvider(): Promise<TelephonyProvider> {
  const name = (await getRule("health")).telephonyProvider;
  return name === "exotel" ? exotelTelephony : name === "knowlarity" ? knowlarityTelephony : mockTelephony;
}

export async function activeVirtualNumber(shopId: string, client: DbClient = db): Promise<HealthVirtualNumber | null> {
  const [row] = await client
    .select()
    .from(healthVirtualNumbers)
    .where(and(eq(healthVirtualNumbers.shopId, shopId), eq(healthVirtualNumbers.status, "ACTIVE")))
    .orderBy(desc(healthVirtualNumbers.assignedAt))
    .limit(1);
  return row ?? null;
}

/** The phone calls are forwarded to: the shop's contact phone, its phone, else the owner's. */
async function forwardNumberOf(shopId: string): Promise<string | null> {
  const [s] = await db.select({ contact: shops.contactPhone, phone: shops.phone, ownerPhone: users.phone }).from(shops).leftJoin(users, eq(users.id, shops.ownerId)).where(eq(shops.id, shopId));
  return s?.contact?.trim() || s?.phone?.trim() || s?.ownerPhone?.trim() || null;
}

/**
 * Gives the shop a virtual number (keeps an existing active one). Outside any transaction. Null when the
 * shop has no phone to forward to, or the provider failed (logged; the plan still works without it).
 */
export async function assignVirtualNumber(shopId: string): Promise<HealthVirtualNumber | null> {
  const existing = await activeVirtualNumber(shopId);
  if (existing) return existing;
  const forwardTo = await forwardNumberOf(shopId);
  if (!forwardTo) {
    console.error("[health] virtual number not assigned: the shop has no phone number", shopId);
    return null;
  }
  try {
    const provider = await telephonyProvider();
    const got = await provider.assignNumber(shopId, forwardTo);
    const [row] = await db
      .insert(healthVirtualNumbers)
      .values({ shopId, number: got.number, forwardTo, provider: provider.name, providerRef: got.providerRef, status: "ACTIVE" })
      .returning();
    return row;
  } catch (error) {
    console.error("[health] virtual number not assigned", shopId, error instanceof Error ? error.message : error);
    return null;
  }
}

/** Releases the shop's active virtual number(s) at the provider and marks them RELEASED. Never throws. */
export async function releaseVirtualNumber(shopId: string, now: Date = new Date()): Promise<number> {
  const rows = await db.select().from(healthVirtualNumbers).where(and(eq(healthVirtualNumbers.shopId, shopId), eq(healthVirtualNumbers.status, "ACTIVE")));
  let released = 0;
  for (const row of rows) {
    try {
      const provider = row.provider === "exotel" ? exotelTelephony : row.provider === "knowlarity" ? knowlarityTelephony : mockTelephony;
      if (row.providerRef) await provider.release(row.providerRef);
    } catch (error) {
      console.error("[health] virtual number release failed at the provider", row.id, error instanceof Error ? error.message : error);
    }
    await db.update(healthVirtualNumbers).set({ status: "RELEASED", releasedAt: now }).where(eq(healthVirtualNumbers.id, row.id));
    released += 1;
  }
  return released;
}

/* ------------------------------------------------------------ webhook */

export const telephonyCallInput = z.object({
  callId: z.string().trim().min(1).max(120),
  virtualNumber: z.string().trim().min(6).max(30),
  caller: z.string().trim().max(30).default(""),
  startedAt: z.string().datetime({ offset: true }),
  durationSeconds: z.coerce.number().int().min(0).max(86_400).default(0),
  status: z.enum(["ANSWERED", "MISSED"]),
});

export const TELEPHONY_SIGNATURE_HEADER = "x-gokesari-signature";

export function telephonySignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * May this webhook call be accepted? With a secret: only a valid signature. Without one: only the mock
 * provider outside production.
 */
export async function verifyTelephonyRequest(rawBody: string, signatureHeader: string | null, env: { secret?: string | null; nodeEnv?: string | null } = {}): Promise<{ ok: boolean; reason?: string }> {
  const secret = env.secret === undefined ? process.env.HEALTH_TELEPHONY_WEBHOOK_SECRET : env.secret;
  const nodeEnv = env.nodeEnv === undefined ? process.env.NODE_ENV : env.nodeEnv;
  if (!secret) {
    const provider = (await getRule("health")).telephonyProvider;
    if (provider === "mock" && nodeEnv !== "production") return { ok: true };
    return { ok: false, reason: "Telephony webhook secret is not configured." };
  }
  const given = (signatureHeader ?? "").trim().replace(/^sha256=/i, "").toLowerCase();
  const expected = telephonySignature(rawBody, secret);
  if (given.length !== expected.length) return { ok: false, reason: "Bad signature." };
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ? { ok: true } : { ok: false, reason: "Bad signature." };
}

/** "XXXXXX3210": the caller's last 4 digits only. */
export function maskCaller(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "Unknown";
  return `XXXXXX${digits.slice(-4)}`;
}

const digitsOf = (n: string) => n.replace(/\D/g, "");

/** Adds to the shop's daily stats (IST day). */
export async function bumpProfileStats(shopId: string, at: Date, delta: { views?: number; calls?: number; missedCalls?: number; bookings?: number }, client: DbClient = db): Promise<void> {
  const day = istDateKey(at);
  const v = { views: delta.views ?? 0, calls: delta.calls ?? 0, missed: delta.missedCalls ?? 0, bookings: delta.bookings ?? 0 };
  await client.execute(sql`
    insert into health.profile_stats (shop_id, day, views, calls, missed_calls, bookings)
    values (${shopId}, ${day}::date, ${v.views}, ${v.calls}, ${v.missed}, ${v.bookings})
    on conflict (shop_id, day) do update set
      views = health.profile_stats.views + excluded.views,
      calls = health.profile_stats.calls + excluded.calls,
      missed_calls = health.profile_stats.missed_calls + excluded.missed_calls,
      bookings = health.profile_stats.bookings + excluded.bookings`);
}

/**
 * One call reported by the provider: logged once per provider call id (a retried webhook changes
 * nothing), counted in the shop's stats; a missed call tells the clinic at once.
 */
export async function recordTelephonyCall(raw: unknown): Promise<{ logged: boolean; reason?: string; log?: HealthCallLog }> {
  const input = telephonyCallInput.parse(raw);
  const target = digitsOf(input.virtualNumber);
  const [vn] = await db
    .select()
    .from(healthVirtualNumbers)
    .where(and(eq(healthVirtualNumbers.status, "ACTIVE"), sql`regexp_replace(${healthVirtualNumbers.number}, '\\D', '', 'g') = ${target}`))
    .limit(1);
  if (!vn) return { logged: false, reason: "Unknown or released number." };
  const startedAt = new Date(input.startedAt);
  const [log] = await db
    .insert(healthCallLogs)
    .values({
      virtualNumberId: vn.id,
      shopId: vn.shopId,
      providerCallId: input.callId,
      callerMasked: maskCaller(input.caller),
      startedAt,
      durationSeconds: input.status === "MISSED" ? 0 : input.durationSeconds,
      status: input.status,
    })
    .onConflictDoNothing({ target: healthCallLogs.providerCallId })
    .returning();
  if (!log) return { logged: false, reason: "Already recorded." };
  await bumpProfileStats(vn.shopId, startedAt, { calls: 1, missedCalls: input.status === "MISSED" ? 1 : 0 });
  if (input.status === "MISSED") {
    const people = await firmUserIds(vn.shopId);
    const time = startedAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
    await publishHealthEvent({ name: "call.missed", userIds: people, shopId: vn.shopId, subjectId: log.id, payload: { callLogId: log.id } });
    for (const userId of people) {
      await notify({
        userId,
        type: NOTIFICATION_TYPES.HEALTH_CALL_MISSED,
        vars: { time: `${time} IST` },
        actionUrl: `/shop/health/prime?shopId=${vn.shopId}`,
        channels: ["PUSH"],
        dedupeKey: `health-call-missed:${log.id}:${userId}`,
        metadata: { callLogId: log.id, shopId: vn.shopId },
      });
    }
  }
  return { logged: true, log };
}

export async function recentCalls(shopId: string, limit = 50): Promise<HealthCallLog[]> {
  return db.select().from(healthCallLogs).where(eq(healthCallLogs.shopId, shopId)).orderBy(desc(healthCallLogs.startedAt)).limit(Math.min(limit, 200));
}
