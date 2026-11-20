/**
 * Consultant appointments: admin and operator tools (docs/consult-booking-2026-11).
 * Categories (with commission and required registration), cancellation
 * policy templates, profile and certificate verification, every booking with
 * filters, refunds / staff cancellation, and reports. consult:manage.
 */
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { CONSULT_BOOKING_STATUSES, CONSULT_MODES, CONSULT_REQUIRED_DOCS } from "@/lib/consult/constants";
import { addDays, isDateKey, istAt, istDateKey } from "@/lib/consult/time";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  consultBookings,
  consultCategories,
  consultMemberDocuments,
  consultMembers,
  consultPolicyTemplates,
  consultProfiles,
  shops,
  type ConsultCategory,
  type ConsultPolicyTemplate,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify, NOTIFICATION_TYPES } from "@/server/services/notifications";
import { isConsultStaff, type ConsultActor } from "./access";
import { bookingCards, type BookingCard } from "./views";

function requireStaff(actor: ConsultActor): void {
  if (!isConsultStaff(actor)) throw forbidden("Consultant management is for GoKesari staff.");
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/* --------------------------------------------------------------- categories */

export const categoryInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(80),
  groupName: z.string().trim().min(2).max(60).default("Other services"),
  description: z.string().trim().max(300).nullish(),
  requiredDoc: z.enum(CONSULT_REQUIRED_DOCS).default("NONE"),
  requiredDocLabel: z.string().trim().max(120).nullish(),
  defaultModes: z.array(z.enum(CONSULT_MODES)).min(1).default(["IN_PERSON"]),
  /** Percent, e.g. 2 for 2%; null: the platform default. */
  commissionPct: z.number().min(0).max(50).nullish(),
  sacCode: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, "A SAC code is 4–8 digits.")
    .nullish()
    .or(z.literal("")),
  sensitive: z.boolean().default(false),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
});

export async function listCategories(actor: ConsultActor): Promise<(ConsultCategory & { consultants: number })[]> {
  requireStaff(actor);
  const rows = await db.select().from(consultCategories).orderBy(asc(consultCategories.sortOrder), asc(consultCategories.name));
  const counts = await db.execute<{ category_id: string; n: number }>(sql`select category_id, count(*)::int as n from consult_member_categories group by category_id`);
  return rows.map((r) => ({ ...r, consultants: Number(counts.find((c) => c.category_id === r.id)?.n ?? 0) }));
}

export async function saveCategory(raw: unknown, actor: ConsultActor): Promise<ConsultCategory> {
  requireStaff(actor);
  const input = categoryInput.parse(raw);
  const values = {
    name: input.name,
    slug: slugify(input.name),
    groupName: input.groupName,
    description: input.description ?? null,
    requiredDoc: input.requiredDoc,
    requiredDocLabel: input.requiredDoc === "NONE" ? null : input.requiredDocLabel || null,
    defaultModes: [...new Set(input.defaultModes)],
    commissionBp: input.commissionPct == null ? null : Math.round(input.commissionPct * 100),
    sacCode: input.sacCode || null,
    sensitive: input.sensitive,
    status: input.status,
    sortOrder: input.sortOrder,
    updatedBy: actor.id,
    updatedAt: new Date(),
  };
  try {
    if (input.id) {
      const [before] = await db.select().from(consultCategories).where(eq(consultCategories.id, input.id));
      if (!before) throw notFound("Category");
      const [row] = await db.update(consultCategories).set({ ...values, slug: before.slug }).where(eq(consultCategories.id, before.id)).returning();
      await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_CATEGORY_CHANGED, entityType: "consult_category", entityId: row.id, previousValue: before, newValue: row });
      return row;
    }
    const [row] = await db.insert(consultCategories).values(values).returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_CATEGORY_CHANGED, entityType: "consult_category", entityId: row.id, newValue: row });
    return row;
  } catch (error) {
    const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
    if (code === "23505") throw conflict("A category with that name already exists.");
    throw error;
  }
}

/* ----------------------------------------------------------- policy templates */

export const templateInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).nullish(),
  freeCancelHours: z.number().int().min(0).max(720),
  lateCancelRefundPct: z.number().int().min(0).max(100),
  noShowRefundPct: z.number().int().min(0).max(100),
  rescheduleMinHours: z.number().int().min(0).max(720),
  maxReschedules: z.number().int().min(0).max(10),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  isDefault: z.boolean().default(false),
});

export async function listTemplates(actor: ConsultActor): Promise<ConsultPolicyTemplate[]> {
  requireStaff(actor);
  return db.select().from(consultPolicyTemplates).orderBy(asc(consultPolicyTemplates.name));
}

export async function saveTemplate(raw: unknown, actor: ConsultActor): Promise<ConsultPolicyTemplate> {
  requireStaff(actor);
  const input = templateInput.parse(raw);
  if (input.isDefault && input.status !== "ACTIVE") throw validationFailed("The default policy must be active.");
  return db.transaction(async (tx) => {
    if (input.isDefault) await tx.update(consultPolicyTemplates).set({ isDefault: false }).where(eq(consultPolicyTemplates.isDefault, true));
    const values = { ...input, description: input.description ?? null, updatedBy: actor.id, updatedAt: new Date() };
    delete (values as { id?: string }).id;
    const [row] = input.id
      ? await tx.update(consultPolicyTemplates).set(values).where(eq(consultPolicyTemplates.id, input.id)).returning()
      : await tx.insert(consultPolicyTemplates).values(values).returning();
    if (!row) throw notFound("Policy template");
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_POLICY_TEMPLATE_CHANGED, entityType: "consult_policy_template", entityId: row.id, newValue: row }, tx);
    return row;
  });
}

/* ---------------------------------------------------------------- profiles */

export interface ProfileRow {
  id: string;
  shopId: string;
  slug: string;
  name: string;
  shopName: string;
  shopStatus: string;
  city: string;
  status: string;
  verification: string;
  verificationNote: string | null;
  kind: string;
  members: { id: string; name: string; docStatus: string; registrationNumber: string | null; registrationBody: string | null; documents: { id: string; fileName: string; createdAt: string }[] }[];
  bookings30d: number;
  createdAt: string;
}

export async function listProfiles(actor: ConsultActor, filter: { verification?: string; q?: string } = {}): Promise<ProfileRow[]> {
  requireStaff(actor);
  const conds = [];
  if (filter.verification && ["PENDING", "VERIFIED", "REJECTED"].includes(filter.verification)) conds.push(eq(consultProfiles.verification, filter.verification as "PENDING"));
  if (filter.q) conds.push(or(ilike(consultProfiles.displayName, `%${filter.q}%`), ilike(shops.name, `%${filter.q}%`), ilike(shops.city, `%${filter.q}%`)));
  const rows = await db
    .select({ p: consultProfiles, slug: shops.slug, shopName: shops.name, shopStatus: shops.status, city: shops.city })
    .from(consultProfiles)
    .innerJoin(shops, eq(shops.id, consultProfiles.shopId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(sql`${consultProfiles.verification} = 'PENDING' DESC`, desc(consultProfiles.updatedAt))
    .limit(300);
  const ids = rows.map((r) => r.p.id);
  const members = ids.length ? await db.select().from(consultMembers).where(inArray(consultMembers.profileId, ids)).orderBy(asc(consultMembers.sortOrder)) : [];
  const docs = members.length
    ? await db.select({ id: consultMemberDocuments.id, memberId: consultMemberDocuments.memberId, fileName: consultMemberDocuments.fileName, createdAt: consultMemberDocuments.createdAt }).from(consultMemberDocuments).where(inArray(consultMemberDocuments.memberId, members.map((m) => m.id)))
    : [];
  const since = new Date(Date.now() - 30 * 86_400_000);
  const counts = ids.length
    ? await db.select({ profileId: consultBookings.profileId, n: sql<number>`count(*)::int` }).from(consultBookings).where(and(inArray(consultBookings.profileId, ids), gte(consultBookings.createdAt, since))).groupBy(consultBookings.profileId)
    : [];
  return rows.map((r) => ({
    id: r.p.id,
    shopId: r.p.shopId,
    slug: r.slug,
    name: r.p.displayName,
    shopName: r.shopName,
    shopStatus: r.shopStatus,
    city: r.city,
    status: r.p.status,
    verification: r.p.verification,
    verificationNote: r.p.verificationNote,
    kind: r.p.kind,
    members: members
      .filter((m) => m.profileId === r.p.id)
      .map((m) => ({
        id: m.id,
        name: m.name,
        docStatus: m.docStatus,
        registrationNumber: m.registrationNumber,
        registrationBody: m.registrationBody,
        documents: docs.filter((d) => d.memberId === m.id).map((d) => ({ id: d.id, fileName: d.fileName, createdAt: d.createdAt.toISOString() })),
      })),
    bookings30d: Number(counts.find((c) => c.profileId === r.p.id)?.n ?? 0),
    createdAt: r.p.createdAt.toISOString(),
  }));
}

export const verifyInput = z.object({
  decision: z.enum(["VERIFIED", "REJECTED", "BLOCK", "UNBLOCK"]),
  note: z.string().trim().max(500).nullish(),
  /** Per-member certificate decisions. */
  members: z.array(z.object({ id: z.string().uuid(), decision: z.enum(["VERIFIED", "REJECTED"]), note: z.string().trim().max(300).nullish() })).max(50).default([]),
});

export async function verifyProfile(profileId: string, raw: unknown, actor: ConsultActor) {
  requireStaff(actor);
  const input = verifyInput.parse(raw);
  const [p] = await db.select({ p: consultProfiles, ownerId: shops.ownerId }).from(consultProfiles).innerJoin(shops, eq(shops.id, consultProfiles.shopId)).where(eq(consultProfiles.id, profileId));
  if (!p) throw notFound("Consultant");
  if ((input.decision === "REJECTED" || input.decision === "BLOCK") && !input.note) throw validationFailed("Give the consultant a reason.");
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    for (const m of input.members) {
      await tx
        .update(consultMembers)
        .set({ docStatus: m.decision, docNote: m.decision === "REJECTED" ? m.note ?? "Certificate not accepted." : null, updatedAt: now })
        .where(and(eq(consultMembers.id, m.id), eq(consultMembers.profileId, profileId)));
    }
    const patch: Partial<typeof consultProfiles.$inferInsert> = { updatedAt: now };
    if (input.decision === "VERIFIED") Object.assign(patch, { verification: "VERIFIED", verificationNote: input.note ?? null, verifiedBy: actor.id, verifiedAt: now });
    if (input.decision === "REJECTED") Object.assign(patch, { verification: "REJECTED", verificationNote: input.note, verifiedBy: actor.id, verifiedAt: now });
    if (input.decision === "BLOCK") Object.assign(patch, { status: "BLOCKED", verificationNote: input.note });
    if (input.decision === "UNBLOCK") Object.assign(patch, { status: "PAUSED" });
    const [row] = await tx.update(consultProfiles).set(patch).where(eq(consultProfiles.id, profileId)).returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_PROFILE_VERIFIED, entityType: "consult_profile", entityId: profileId, previousValue: { status: p.p.status, verification: p.p.verification }, newValue: { decision: input.decision, note: input.note, members: input.members } }, tx);
    await notify(
      {
        userId: p.ownerId,
        type: NOTIFICATION_TYPES.CONSULT_VERIFICATION,
        title:
          input.decision === "VERIFIED"
            ? "Your consultant profile is verified"
            : input.decision === "REJECTED"
              ? "Your consultant profile needs changes"
              : input.decision === "BLOCK"
                ? "Your consultant profile is blocked"
                : "Your consultant profile is unblocked",
        body: input.note ? input.note : input.decision === "VERIFIED" ? "Customers now see the Verified badge on your profile." : input.decision === "UNBLOCK" ? "Publish it again from Appointments → Setup." : "Open Appointments → Setup to see what to change.",
        actionUrl: "/shop/consult/setup",
        channels: ["PUSH"],
      },
      tx,
    );
    return row;
  });
  return result;
}

/* ---------------------------------------------------------------- bookings */

export const bookingFilter = z.object({
  status: z.enum(CONSULT_BOOKING_STATUSES).optional(),
  from: z.string().refine(isDateKey).optional(),
  to: z.string().refine(isDateKey).optional(),
  q: z.string().trim().max(80).optional(),
  shopId: z.string().uuid().optional(),
  refunds: z.coerce.boolean().optional(),
  disputes: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function listAllBookings(actor: ConsultActor, raw: unknown): Promise<BookingCard[]> {
  requireStaff(actor);
  const f = bookingFilter.parse(raw);
  const conds = [];
  if (f.status) conds.push(eq(consultBookings.status, f.status));
  if (f.from) conds.push(gte(consultBookings.startsAt, istAt(f.from, 0)));
  if (f.to) conds.push(lt(consultBookings.startsAt, istAt(addDays(f.to, 1), 0)));
  if (f.shopId) conds.push(eq(consultBookings.shopId, f.shopId));
  if (f.refunds) conds.push(sql`${consultBookings.refundPaise} > 0`);
  if (f.disputes) conds.push(sql`${consultBookings.ticketId} IS NOT NULL`);
  if (f.q) conds.push(or(ilike(consultBookings.bookingNumber, `%${f.q}%`), ilike(consultBookings.visitorName, `%${f.q}%`), ilike(consultBookings.serviceName, `%${f.q}%`)));
  const rows = await db.select().from(consultBookings).where(conds.length ? and(...conds) : undefined).orderBy(desc(consultBookings.startsAt)).limit(f.limit);
  return bookingCards(rows);
}

/* ----------------------------------------------------------------- reports */

export interface ConsultReport {
  from: string;
  to: string;
  totals: { bookings: number; completed: number; cancelled: number; noShows: number; confirmed: number; grossPaise: number; refundsPaise: number; commissionPaise: number; onlinePaise: number; offlinePaise: number };
  byStatus: { status: string; n: number }[];
  byCategory: { name: string; bookings: number; grossPaise: number; commissionPaise: number }[];
  byArea: { area: string; bookings: number; grossPaise: number }[];
  byDay: { day: string; bookings: number; grossPaise: number }[];
  topConsultants: { name: string; city: string; bookings: number; grossPaise: number; rating: number }[];
}

export async function consultReport(actor: ConsultActor, fromKey?: string, toKey?: string): Promise<ConsultReport> {
  requireStaff(actor);
  const to = toKey && isDateKey(toKey) ? toKey : istDateKey(new Date());
  const from = fromKey && isDateKey(fromKey) ? fromKey : addDays(to, -29);
  const a = istAt(from, 0);
  const b = istAt(addDays(to, 1), 0);
  const range = sql`b.starts_at >= ${a.toISOString()}::timestamptz and b.starts_at < ${b.toISOString()}::timestamptz and b.status <> 'EXPIRED'`;
  const money = sql`(b.paid_online_paise + b.paid_offline_paise - b.refund_paise)`;
  const [totals] = await db.execute<Record<string, number>>(sql`
    select count(*)::int as bookings,
      count(*) filter (where b.status = 'COMPLETED')::int as completed,
      count(*) filter (where b.status in ('CANCELLED','REJECTED'))::int as cancelled,
      count(*) filter (where b.status = 'NO_SHOW')::int as no_shows,
      count(*) filter (where b.status in ('CONFIRMED','PENDING_APPROVAL'))::int as confirmed,
      coalesce(sum(${money}), 0)::bigint as gross,
      coalesce(sum(b.refund_paise), 0)::bigint as refunds,
      coalesce(sum(b.commission_paise), 0)::bigint as commission,
      coalesce(sum(b.paid_online_paise), 0)::bigint as online,
      coalesce(sum(b.paid_offline_paise), 0)::bigint as offline
    from consult_bookings b where ${range}`);
  const byStatus = await db.execute<{ status: string; n: number }>(sql`select b.status, count(*)::int as n from consult_bookings b where ${range} group by b.status order by n desc`);
  const byCategory = await db.execute<{ name: string; bookings: number; gross: number; commission: number }>(sql`
    select coalesce(c.name, 'Uncategorised') as name, count(*)::int as bookings, coalesce(sum(${money}), 0)::bigint as gross, coalesce(sum(b.commission_paise), 0)::bigint as commission
    from consult_bookings b left join consult_categories c on c.id = b.category_id where ${range} group by 1 order by bookings desc limit 20`);
  const byArea = await db.execute<{ area: string; bookings: number; gross: number }>(sql`
    select coalesce(nullif(s.area, ''), s.city) || ', ' || s.pincode as area, count(*)::int as bookings, coalesce(sum(${money}), 0)::bigint as gross
    from consult_bookings b join shops s on s.id = b.shop_id where ${range} group by 1 order by bookings desc limit 20`);
  const byDay = await db.execute<{ day: string; bookings: number; gross: number }>(sql`
    select to_char(b.starts_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as day, count(*)::int as bookings, coalesce(sum(${money}), 0)::bigint as gross
    from consult_bookings b where ${range} group by 1 order by 1`);
  const top = await db.execute<{ name: string; city: string; bookings: number; gross: number; rating: number }>(sql`
    select p.display_name as name, s.city, count(*)::int as bookings, coalesce(sum(${money}), 0)::bigint as gross, (p.rating_avg_x100 / 100.0)::float as rating
    from consult_bookings b join consult_profiles p on p.id = b.profile_id join shops s on s.id = b.shop_id where ${range}
    group by p.id, s.city order by bookings desc limit 10`);
  return {
    from,
    to,
    totals: {
      bookings: Number(totals?.bookings ?? 0),
      completed: Number(totals?.completed ?? 0),
      cancelled: Number(totals?.cancelled ?? 0),
      noShows: Number(totals?.no_shows ?? 0),
      confirmed: Number(totals?.confirmed ?? 0),
      grossPaise: Number(totals?.gross ?? 0),
      refundsPaise: Number(totals?.refunds ?? 0),
      commissionPaise: Number(totals?.commission ?? 0),
      onlinePaise: Number(totals?.online ?? 0),
      offlinePaise: Number(totals?.offline ?? 0),
    },
    byStatus: byStatus.map((r) => ({ status: r.status, n: Number(r.n) })),
    byCategory: byCategory.map((r) => ({ name: r.name, bookings: Number(r.bookings), grossPaise: Number(r.gross), commissionPaise: Number(r.commission) })),
    byArea: byArea.map((r) => ({ area: r.area, bookings: Number(r.bookings), grossPaise: Number(r.gross) })),
    byDay: byDay.map((r) => ({ day: r.day, bookings: Number(r.bookings), grossPaise: Number(r.gross) })),
    topConsultants: top.map((r) => ({ name: r.name, city: r.city, bookings: Number(r.bookings), grossPaise: Number(r.gross), rating: Number(r.rating) })),
  };
}

/** Counts for the staff board tile: profiles awaiting verification, open booking disputes. */
export async function staffConsultCounts(): Promise<{ pendingVerification: number; disputes: number }> {
  const [v] = await db.select({ n: sql<number>`count(*)::int` }).from(consultProfiles).where(and(eq(consultProfiles.verification, "PENDING"), eq(consultProfiles.status, "LIVE")));
  const [d] = await db.execute<{ n: number }>(sql`select count(*)::int as n from consult_bookings b join support_tickets t on t.id = b.ticket_id where t.status not in ('RESOLVED','CLOSED')`);
  return { pendingVerification: Number(v?.n ?? 0), disputes: Number(d?.n ?? 0) };
}
