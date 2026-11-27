/**
 * The franchise job (every 5 minutes; brief §4.4, §8.2, §9): expired holds released, areas past their expiry
 * moment EXPIRED (renewal off, slot free, codes closed for that zone), expiry reminders at 10:00 IST, the
 * 09:00 IST digest to the CEO, and the monthly run on the 1st from 02:00 IST. Every send is logged once in
 * franchise_notification_log, which is also what stops a second send; a late run catches up.
 */
import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

import { formatIst, istDate, istHour, reminderDue, rupees, addDays, type ReminderKind } from "@/lib/franchise";
import { db } from "@/server/db";
import { dealers, franchiseAllocations, franchiseNotificationLog, franchiseZones, users, type FranchiseAllocation } from "@/server/db/schema";
import { sendEmail } from "@/server/email/transport";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { flow4On, wave4Rule } from "@/server/flows/wave4";
import { releaseExpiredHolds, releaseHeldPaymentSlots, releaseLapsedPlanPayments, sweepFranchiseKyc } from "./booking";
import { closeAllocationCodes } from "./codes";
import { calculateFranchiseMonth, lockFranchiseMonth, prevMonth } from "./commission";
import { emailStatements } from "./statements";
import { franchiseConfig, franchiseNow, tierDisplayOf, type FranchiseConfig } from "./config";
import { currentFee, runZoneStatusJobs, syncSoldOut } from "./zones";

const SITE = () => (process.env.APP_BASE_URL ?? process.env.NEXTAUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");

/** Claims one send (allocation, kind, day, channel, recipient). False when it was already sent. */
async function claim(input: { allocationId: string | null; kind: string; dueOn: string; channel: "EMAIL" | "SMS" | "WHATSAPP" | "PUSH" | "IN_APP" | "ADMIN_ALERT"; recipient: string; status?: "QUEUED" | "SENT" | "SKIPPED"; detail?: string }): Promise<string | null> {
  const [row] = await db
    .insert(franchiseNotificationLog)
    .values({ allocationId: input.allocationId, kind: input.kind, dueOn: input.dueOn, channel: input.channel, recipient: input.recipient.slice(0, 200), status: input.status ?? "QUEUED", detail: input.detail?.slice(0, 500) ?? null })
    .onConflictDoNothing()
    .returning({ id: franchiseNotificationLog.id });
  return row?.id ?? null;
}

async function settle(id: string, status: "SENT" | "FAILED", detail?: string): Promise<void> {
  await db.update(franchiseNotificationLog).set({ status, detail: detail?.slice(0, 500) ?? null, sentAt: new Date() }).where(eq(franchiseNotificationLog.id, id));
}

interface AreaRow {
  a: FranchiseAllocation;
  zoneName: string;
  zoneStatus: string;
  ownerName: string;
  ownerUserId: string | null;
  ownerEmail: string | null;
}

async function areas(where: ReturnType<typeof and>): Promise<AreaRow[]> {
  const rows = await db
    .select({ a: franchiseAllocations, zoneName: franchiseZones.name, zoneStatus: franchiseZones.status, ownerName: dealers.legalName, ownerUserId: dealers.userId, ownerEmail: users.email })
    .from(franchiseAllocations)
    .innerJoin(franchiseZones, eq(franchiseZones.zoneId, franchiseAllocations.zoneId))
    .innerJoin(dealers, eq(dealers.id, franchiseAllocations.ownerDealerId))
    .leftJoin(users, eq(users.id, dealers.userId))
    .where(where);
  return rows.map((r) => ({ ...r, ownerEmail: r.ownerEmail ?? null }));
}

/** Email to the owner's address and the CC list, each logged. Returns how many were attempted for the first time. */
async function emailAll(area: AreaRow | null, kind: string, dueOn: string, subject: string, text: string, config: FranchiseConfig): Promise<number> {
  const to = [...new Set([...(area?.ownerEmail ? [area.ownerEmail] : []), ...config.expiryCc])];
  let sent = 0;
  for (const recipient of to) {
    const id = await claim({ allocationId: area?.a.id ?? null, kind, dueOn, channel: "EMAIL", recipient });
    if (!id) continue;
    sent++;
    try {
      await sendEmail({ to: recipient, subject, text });
      await settle(id, "SENT");
    } catch (e) {
      await settle(id, "FAILED", e instanceof Error ? e.message : String(e));
    }
  }
  return sent;
}

/** In-app, push, SMS and WhatsApp to the owner (email goes through emailAll so the CC is in the same log). */
async function tellOwnerChannels(area: AreaRow, kind: string, dueOn: string, title: string, message: string, actionUrl: string): Promise<void> {
  if (!area.ownerUserId) return;
  const id = await claim({ allocationId: area.a.id, kind, dueOn, channel: "IN_APP", recipient: area.ownerUserId });
  if (!id) return;
  await notify({ userId: area.ownerUserId, type: NOTIFICATION_TYPES.FRANCHISE_NOTICE, vars: { title, message }, actionUrl, channels: ["PUSH", "SMS", "WHATSAPP"], emailDetail: undefined, dedupeKey: `franchise:${kind}:${area.a.id}:${dueOn}` } as Parameters<typeof notify>[0]);
  await settle(id, "SENT", "in-app + push + SMS + WhatsApp queued (notification outbox)");
  for (const channel of ["PUSH", "SMS", "WHATSAPP"] as const) await claim({ allocationId: area.a.id, kind, dueOn, channel, recipient: area.ownerUserId, status: "QUEUED", detail: "via the notification outbox" });
}

/** Brief §9.4: every area past its expiry moment becomes EXPIRED (idempotent; read paths also check the time). */
export async function expireAreas(now: Date, config: FranchiseConfig): Promise<number> {
  const due = await areas(and(inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"]), lt(franchiseAllocations.expiresAt, now)));
  let n = 0;
  for (const area of due) {
    const done = await db.transaction(async (tx) => {
      const moved = await tx
        .update(franchiseAllocations)
        .set({ status: "EXPIRED", endedAt: area.a.expiresAt, endReason: "not renewed by the expiry date", updatedAt: now })
        .where(and(eq(franchiseAllocations.id, area.a.id), inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"])))
        .returning({ id: franchiseAllocations.id });
      if (!moved.length) return false;
      const codesClosed = await closeAllocationCodes(tx, area.a, now);
      await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_ALLOCATION_CHANGED, entityType: "franchise_allocation", entityId: area.a.id, previousValue: { status: area.a.status }, newValue: { status: "EXPIRED", zoneId: area.a.zoneId, slotReleased: area.a.slotNo, renewal: "disabled", codesClosed, tailEndAt: area.a.tailEndAt?.toISOString() ?? null } }, tx);
      return true;
    });
    if (!done) continue;
    n++;
    await syncSoldOut(area.a.zoneId).catch(() => {});
    const day = istDate(now);
    const subject = `Franchise expired: zone ${area.a.zoneId} (${area.zoneName})`;
    const text = [
      `Franchise in zone ${area.a.zoneId} — ${area.zoneName} — expired on ${formatIst(area.a.expiresAt)}.`,
      `Owner: ${area.ownerName}.`,
      "Renewal is now closed for this area and the franchise code no longer adds new shops in it. The slot is free for a fresh booking by anyone, with no priority.",
      `Recurring commission on shops already registered continues until ${formatIst(area.a.tailEndAt)}, then stops.`,
      `${SITE()}/franchise/book`,
    ].join("\n");
    await emailAll(area, "EXPIRED", day, subject, text, config);
    await tellOwnerChannels(area, "EXPIRED", day, "Franchise area expired", `Zone ${area.a.zoneId} expired on ${formatIst(area.a.expiresAt)}. Renewal is closed; you can book it again if a slot is free.`, "/franchise/my");
    await claim({ allocationId: area.a.id, kind: "EXPIRED", dueOn: day, channel: "ADMIN_ALERT", recipient: "admin-dashboard", status: "SENT", detail: subject });
  }
  return n;
}

const REMINDER_WORDS: Record<ReminderKind, string> = { D30: "in 30 days", D15: "in 15 days", DAILY: "soon" };

/**
 * §4.2 / §5.5: 30 days, 15 days, then every day to the expiry day — at the reminder hour, every channel, CC the CEO —
 * with the renewal fee (the zone's current published fee) and, when it changed, why. A franchise in an Inactive zone
 * cannot renew (§5.6): its owner is told once, `inactiveNoticeDays` before expiry, instead.
 */
export async function sendReminders(now: Date, config: FranchiseConfig): Promise<number> {
  if (istHour(now) < config.reminderHourIst) return 0;
  const today = istDate(now);
  const horizon = new Date(now.getTime() + Math.max(31, config.inactiveNoticeDays + 1) * 86_400_000);
  const active = await areas(and(eq(franchiseAllocations.status, "ACTIVE"), gte(franchiseAllocations.expiresAt, now), lte(franchiseAllocations.expiresAt, horizon), eq(franchiseAllocations.isTest, false)));
  const names = tierDisplayOf(config).names;
  let n = 0;
  for (const area of active) {
    if (area.zoneStatus === "INACTIVE") {
      const daysLeft = Math.floor((area.a.expiresAt!.getTime() - now.getTime()) / 86_400_000);
      if (daysLeft > config.inactiveNoticeDays) continue;
      const subject = `Franchise zone ${area.a.zoneId} is inactive: your franchise ends on ${formatIst(area.a.expiresAt, false)}`;
      const text = [
        `Zone ${area.a.zoneId} — ${area.zoneName} (owner: ${area.ownerName}) has been made inactive by GoKesari.`,
        `Your franchise runs to the end of its paid term, ${formatIst(area.a.expiresAt)}. Renewal is not available for this zone.`,
        "Recurring commission on your own team's shops continues for the tail period after expiry, as in your terms.",
        `${SITE()}/franchise/my`,
      ].join("\n");
      const sent = await emailAll(area, "INACTIVE_NOTICE", today, subject, text, config);
      await tellOwnerChannels(area, "INACTIVE_NOTICE", today, `Zone ${area.a.zoneId} is inactive`, `Your franchise runs until ${formatIst(area.a.expiresAt)}; renewal is not available for this zone.`, "/franchise/my");
      if (sent) n++;
      continue;
    }
    const due = reminderDue(area.a.expiresAt!, now);
    if (!due) continue;
    const fee = await currentFee(area.a.zoneId);
    const amount = fee == null ? "the renewal fee (to be announced)" : `${rupees(Number(fee.feePaise))} + GST`;
    const changed = fee != null && Number(fee.feePaise) !== Number(area.a.feePaise);
    const why = changed && fee ? ` The fee changed from ${rupees(Number(area.a.feePaise))}: the zone's annual fee was updated from new business data — it is now a ${names[fee.tier]} zone, business about ${Math.round(Math.abs(fee.diffBp) / 100)}% ${fee.diffBp >= 0 ? "above" : "below"} the zone average.` : "";
    const subject = `Renew your franchise: zone ${area.a.zoneId} expires ${due.daysLeft === 0 ? "today" : `in ${due.daysLeft} day${due.daysLeft === 1 ? "" : "s"}`}`;
    const text = [
      `Zone ${area.a.zoneId} — ${area.zoneName} (owner: ${area.ownerName}) expires on ${formatIst(area.a.expiresAt)}.`,
      `Days left: ${due.daysLeft}. Renewal fee: ${amount}.${why}`,
      `Renew: ${SITE()}/franchise/my#renew-${area.a.id}`,
      "Renewal is open until 23:59:59 IST on the expiry date. After that the franchise ends and its slot is released.",
    ].join("\n");
    const sent = await emailAll(area, due.kind, today, subject, text, config);
    await tellOwnerChannels(area, due.kind, today, `Franchise zone ${area.a.zoneId} expires ${REMINDER_WORDS[due.kind] === "soon" ? (due.daysLeft === 0 ? "today" : `in ${due.daysLeft} days`) : REMINDER_WORDS[due.kind]}`, `Renew zone ${area.a.zoneId} for ${amount} before ${formatIst(area.a.expiresAt)}.${why}`, `/franchise/my#renew-${area.a.id}`);
    if (sent) n++;
  }
  return n;
}

/** Brief §9.2: the 09:00 IST digest to the CC list — expiring in 30 days, and expired yesterday. Once a day. */
export async function sendDigest(now: Date, config: FranchiseConfig): Promise<boolean> {
  if (istHour(now) < config.digestHourIst || !config.expiryCc.length) return false;
  const today = istDate(now);
  const yesterday = addDays(today, -1);
  const soon = await areas(and(inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"]), gte(franchiseAllocations.expiresAt, now), lte(franchiseAllocations.expiresAt, new Date(now.getTime() + 30 * 86_400_000)), eq(franchiseAllocations.isTest, false)));
  const expired = (await areas(and(eq(franchiseAllocations.status, "EXPIRED"), eq(franchiseAllocations.isTest, false), sql`(${franchiseAllocations.expiresAt} at time zone 'Asia/Kolkata')::date = ${yesterday}::date`))).filter(Boolean);
  const lines = [
    `GoKesari franchise areas — digest for ${formatIst(now, false)} (IST)`,
    "",
    `Expiring in the next 30 days: ${soon.length}`,
    ...soon.sort((a, b) => a.a.expiresAt!.getTime() - b.a.expiresAt!.getTime()).map((r) => `  • Zone ${r.a.zoneId} (${r.zoneName}) — ${r.ownerName} — expires ${formatIst(r.a.expiresAt)}`),
    "",
    `Expired yesterday (${yesterday}): ${expired.length}`,
    ...expired.map((r) => `  • Zone ${r.a.zoneId} (${r.zoneName}) — ${r.ownerName}`),
    "",
    `${SITE()}/admin/franchise?tab=expiring`,
  ];
  let any = false;
  for (const recipient of config.expiryCc) {
    const id = await claim({ allocationId: null, kind: "DIGEST", dueOn: today, channel: "EMAIL", recipient });
    if (!id) continue;
    try {
      await sendEmail({ to: recipient, subject: `Franchise expiry digest — ${soon.length} expiring, ${expired.length} expired yesterday`, text: lines.join("\n") });
      await settle(id, "SENT");
      any = true;
    } catch (e) {
      await settle(id, "FAILED", e instanceof Error ? e.message : String(e));
    }
  }
  return any;
}

/** The every-5-minutes franchise job. A no-op apart from cheap indexed queries when nothing is due. */
/**
 * Pay first, KYC after (owner 22-Nov-2026): zones whose owner finished KYC go live; owners are reminded 7 days and
 * 1 day before the 30 days end; after that the admins (franchise CC list) are told once a day that the booking is
 * overdue — refund it to free the zone (Admin → Franchise → bookings), or give him more time.
 * Onboarding v2 (bookings with a plan, flag onboarding_v2) sets no kyc_due_at, so its franchises are skipped here.
 */
async function kycSweep(now: Date, config: FranchiseConfig): Promise<{ live: number; waiting: number; reminded: number; overdue: number }> {
  const { live, waiting } = await sweepFranchiseKyc(now);
  const today = istDate(now);
  let reminded = 0;
  const overdue: typeof waiting = [];
  for (const w of waiting) {
    if (w.daysLeft <= 0) {
      overdue.push(w);
      continue;
    }
    if (w.daysLeft !== 7 && w.daysLeft !== 1) continue;
    const [owner] = await db.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, w.ownerDealerId));
    if (!owner?.userId) continue;
    const id = await claim({ allocationId: w.id, kind: `KYC_DUE_${w.daysLeft}`, dueOn: today, channel: "IN_APP", recipient: owner.userId });
    if (!id) continue;
    await notify({ userId: owner.userId, type: NOTIFICATION_TYPES.FRANCHISE_NOTICE, vars: { title: "Finish your KYC to go live", message: `Zone ${w.zoneId} is paid for and waiting for your dealer KYC and bank details — ${w.daysLeft === 1 ? "1 day" : `${w.daysLeft} days`} left (by ${formatIst(w.dueAt)}).` }, actionUrl: "/dealer/apply", channels: ["PUSH", "SMS", "WHATSAPP"], dedupeKey: `franchise:kyc-due:${w.id}:${w.daysLeft}` });
    await settle(id, "SENT");
    reminded++;
  }
  if (overdue.length) {
    const lines = overdue.map((w) => `${w.zoneId} — booking ${w.bookingId}, KYC was due ${formatIst(w.dueAt)}`);
    await emailAll(null, "KYC_OVERDUE", today, `Franchise: ${overdue.length} paid zone(s) past the 30-day KYC limit`, `These franchise zones were paid for but the owner's KYC is still not approved after 30 days:\n\n${lines.join("\n")}\n\nRefund the booking to free the zone (Admin → Franchise → Bookings), or approve the dealer if the KYC is now complete.\n${SITE()}/admin/franchise`, config);
  }
  return { live, waiting: waiting.length, reminded, overdue: overdue.length };
}

export async function runFranchiseJob(real: Date = new Date()): Promise<Record<string, unknown>> {
  const { config } = await franchiseConfig();
  const now = franchiseNow(config, real);
  const out: Record<string, unknown> = { at: now.toISOString() };
  out.holdsReleased = await releaseExpiredHolds(db, now);
  // docs/flows-v3/wave4.md F21 (flag flow_f21): slots held for a payment still open are released at hold + grace.
  if (await flow4On("flow_f21")) {
    out.heldWhilePaying = await releaseHeldPaymentSlots(db, now, (await wave4Rule()).holdGraceMinutes)
      .then(async (zones) => {
        for (const z of zones) await syncSoldOut(z).catch((e: unknown) => console.error("[franchise] sold-out sync failed", z, e));
        return zones.length;
      })
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  }
  // QA D-169: onboarding v2 plan bookings whose checkout was left open past "held until".
  out.lapsedPlanPayments = await releaseLapsedPlanPayments(now).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  // §5.6: scheduled zone status changes due now, and reservations past their expiry back to Available.
  out.zoneStatus = await runZoneStatusJobs(real).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  out.kyc = await kycSweep(now, config).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  // Onboarding v2: paid plan bookings whose go-live (dealer approval, GKF code) did not finish at capture.
  out.v2GoLive = await (await import("@/server/onboarding-v2/franchise")).retryV2GoLive().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  out.expired = await expireAreas(now, config);
  out.reminded = await sendReminders(now, config);
  out.digest = await sendDigest(now, config);
  // Brief 21-Nov §5 (IST): days 1..calcLastDay from calcHourIst — calculate last month (once an hour, rerunnable,
  // DRAFT); statementDay from statementHourIst — e-mail the statements; from the 5th — lock (the payout close
  // on the 5th locks it too). A locked month never changes; later corrections go to the next month.
  const day = Number(istDate(now).slice(8, 10));
  const month = prevMonth(istDate(now).slice(0, 7));
  const err = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
  if (day <= config.calcLastDay && istHour(now) >= config.calcHourIst && now.getUTCMinutes() < 5) out.calculated = await calculateFranchiseMonth(month).catch(err);
  if (day === config.statementDay && istHour(now) >= config.statementHourIst) out.statements = await emailStatements(month, config.expiryCc).catch(err);
  if (day >= 5 && day <= 7 && now.getUTCMinutes() < 5) out.locked = await lockFranchiseMonth(month).catch(err);
  return out;
}
