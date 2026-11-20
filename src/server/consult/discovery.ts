/**
 * Consultant appointments: "Find a Consultant" (docs/consult-booking-2026-11).
 * Search by category, service, name, language, mode, fee range and a date
 * with free time; nearest first from the customer's location (the same
 * Haversine-in-SQL as Nearby shops — no PostGIS, no Google call), with
 * distance, directions, rating and the next free time.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { CONSULT_MODES } from "@/lib/consult/constants";
import { freeSlots } from "@/lib/consult/slots";
import { addDays, isDateKey, istAt, istDateKey } from "@/lib/consult/time";
import { directionsUrl, formatDistance } from "@/lib/geo/nearby";
import { notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { consultCategories, consultMemberCategories, consultMembers, consultProfiles, consultServices, consultWeeklyHours, shops, type ConsultCategory, type ConsultMember, type ConsultProfile, type ConsultService } from "@/server/db/schema";
import { getRule } from "@/server/services/settings";
import { loadCalendars, membersForService, nextAvailableByProfile, rulesOf, serviceShape } from "./availability";

export const searchInput = z.object({
  q: z.string().trim().max(80).optional(),
  category: z.string().trim().max(80).optional(),
  language: z.string().trim().max(40).optional(),
  mode: z.enum(CONSULT_MODES).optional(),
  minFee: z.coerce.number().min(0).max(1_000_000).optional(),
  maxFee: z.coerce.number().min(0).max(1_000_000).optional(),
  date: z.string().refine(isDateKey).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(30),
});
export type SearchInput = z.input<typeof searchInput>;

export interface ConsultantCard {
  profileId: string;
  shopId: string;
  slug: string;
  name: string;
  headline: string | null;
  photoUrl: string | null;
  kind: string;
  verified: boolean;
  categories: string[];
  languages: string[];
  modes: string[];
  feeFromPaise: number | null;
  feeToPaise: number | null;
  rating: number;
  ratingCount: number;
  area: string;
  latitude: number | null;
  longitude: number | null;
  distanceKm: number | null;
  distanceText: string | null;
  directionsUrl: string | null;
  nextSlot: string | null;
  teamSize: number;
}

const NUMBER = "^\\s*-?[0-9]{1,3}(\\.[0-9]+)?\\s*$";

/** Live, bookable profiles of approved shops. */
const BOOKABLE = sql`(${consultProfiles.status} = 'LIVE' AND ${consultProfiles.verification} <> 'REJECTED' AND ${shops.status} = 'APPROVED' AND ${shops.deletedAt} IS NULL)`;

export async function searchConsultants(raw: unknown, now: Date = new Date()): Promise<{ results: ConsultantCard[]; origin: { latitude: number; longitude: number } | null; radiusKm: number }> {
  const input = searchInput.parse(raw);
  const rule = await getRule("consultBooking");
  const radiusKm = input.radiusKm ?? rule.nearbyRadiusKm;
  const origin = input.lat != null && input.lng != null ? { latitude: input.lat, longitude: input.lng } : null;
  const lat = sql`coalesce(${consultProfiles.latitude}, CASE WHEN ${shops.latitude} ~ ${NUMBER} THEN trim(${shops.latitude})::double precision END)`;
  const lng = sql`coalesce(${consultProfiles.longitude}, CASE WHEN ${shops.longitude} ~ ${NUMBER} THEN trim(${shops.longitude})::double precision END)`;
  const distance = origin
    ? sql<number>`(6371 * 2 * asin(sqrt(power(sin(radians((${lat} - ${origin.latitude}) / 2)), 2) + cos(radians(${origin.latitude})) * cos(radians(${lat})) * power(sin(radians((${lng} - ${origin.longitude}) / 2)), 2))))`
    : sql<number>`NULL::double precision`;
  const filters = [BOOKABLE];
  if (input.q) {
    const like = `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    filters.push(sql`(${consultProfiles.displayName} ILIKE ${like} OR ${consultProfiles.headline} ILIKE ${like} OR ${shops.name} ILIKE ${like}
      OR EXISTS (SELECT 1 FROM consult_members m WHERE m.profile_id = ${consultProfiles.id} AND m.status = 'ACTIVE' AND (m.name ILIKE ${like} OR m.qualifications ILIKE ${like}))
      OR EXISTS (SELECT 1 FROM consult_services s WHERE s.profile_id = ${consultProfiles.id} AND s.status = 'ACTIVE' AND (s.name ILIKE ${like} OR s.description ILIKE ${like})))`);
  }
  if (input.category) {
    filters.push(sql`(EXISTS (SELECT 1 FROM consult_members m JOIN consult_member_categories mc ON mc.member_id = m.id JOIN consult_categories c ON c.id = mc.category_id
      WHERE m.profile_id = ${consultProfiles.id} AND m.status = 'ACTIVE' AND (c.slug = ${input.category} OR c.id::text = ${input.category}))
      OR EXISTS (SELECT 1 FROM consult_services s JOIN consult_categories c ON c.id = s.category_id WHERE s.profile_id = ${consultProfiles.id} AND s.status = 'ACTIVE' AND (c.slug = ${input.category} OR c.id::text = ${input.category})))`);
  }
  if (input.language) filters.push(sql`EXISTS (SELECT 1 FROM consult_members m WHERE m.profile_id = ${consultProfiles.id} AND m.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM unnest(m.languages) l WHERE lower(l) = lower(${input.language})))`);
  if (input.mode || input.minFee != null || input.maxFee != null) {
    const conds = [sql`s.profile_id = ${consultProfiles.id}`, sql`s.status = 'ACTIVE'`];
    if (input.mode) conds.push(sql`${input.mode} = ANY(s.modes)`);
    if (input.minFee != null) conds.push(sql`s.fee_paise >= ${Math.round(input.minFee * 100)}`);
    if (input.maxFee != null) conds.push(sql`s.fee_paise <= ${Math.round(input.maxFee * 100)}`);
    filters.push(sql`EXISTS (SELECT 1 FROM consult_services s WHERE ${sql.join(conds, sql` AND `)})`);
  }
  if (origin) filters.push(sql`${distance} <= ${radiusKm}`);
  const rows = await db
    .select({ profile: consultProfiles, slug: shops.slug, area: shops.area, city: shops.city, pincode: shops.pincode, lat: sql<number | null>`${lat}`, lng: sql<number | null>`${lng}`, distanceKm: distance })
    .from(consultProfiles)
    .innerJoin(shops, eq(shops.id, consultProfiles.shopId))
    .where(and(...filters))
    .orderBy(origin ? sql`${distance} ASC NULLS LAST` : sql`${consultProfiles.ratingAvgX100} DESC, ${consultProfiles.displayName} ASC`)
    .limit(input.date ? 120 : input.limit);
  let cards = await toCards(rows.map((r) => ({ ...r, distanceKm: r.distanceKm == null ? null : Number(r.distanceKm) })), origin, now);
  if (input.date) {
    const withSlots = await profilesFreeOn(cards.map((c) => c.profileId), input.date, now);
    cards = cards.filter((c) => withSlots.has(c.profileId)).map((c) => ({ ...c, nextSlot: withSlots.get(c.profileId) ?? c.nextSlot })).slice(0, input.limit);
  }
  return { results: cards, origin, radiusKm };
}

async function toCards(
  rows: { profile: ConsultProfile; slug: string; area: string | null; city: string; pincode: string; lat: number | null; lng: number | null; distanceKm: number | null }[],
  origin: { latitude: number; longitude: number } | null,
  now: Date,
): Promise<ConsultantCard[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.profile.id);
  const [members, services, cats, next] = await Promise.all([
    db.select().from(consultMembers).where(and(inArray(consultMembers.profileId, ids), eq(consultMembers.status, "ACTIVE"))),
    db.select().from(consultServices).where(and(inArray(consultServices.profileId, ids), eq(consultServices.status, "ACTIVE"))),
    db
      .select({ profileId: consultMembers.profileId, name: consultCategories.name })
      .from(consultMemberCategories)
      .innerJoin(consultMembers, eq(consultMembers.id, consultMemberCategories.memberId))
      .innerJoin(consultCategories, eq(consultCategories.id, consultMemberCategories.categoryId))
      .where(inArray(consultMembers.profileId, ids)),
    nextAvailableByProfile(rows.map((r) => r.profile), 14, now),
  ]);
  return rows.map((r) => {
    const p = r.profile;
    const svc = services.filter((s) => s.profileId === p.id);
    const fees = svc.map((s) => s.feePaise);
    const lat = r.lat == null ? null : Number(r.lat);
    const lng = r.lng == null ? null : Number(r.lng);
    return {
      profileId: p.id,
      shopId: p.shopId,
      slug: r.slug,
      name: p.displayName,
      headline: p.headline,
      photoUrl: p.photoUrl,
      kind: p.kind,
      verified: p.verification === "VERIFIED",
      categories: [...new Set(cats.filter((c) => c.profileId === p.id).map((c) => c.name))],
      languages: [...new Set(members.filter((m) => m.profileId === p.id).flatMap((m) => m.languages))],
      modes: [...new Set(svc.flatMap((s) => s.modes))],
      feeFromPaise: fees.length ? Math.min(...fees) : null,
      feeToPaise: fees.length ? Math.max(...fees) : null,
      rating: p.ratingAvgX100 / 100,
      ratingCount: p.ratingCount,
      area: [r.area, r.city].filter(Boolean).join(", "),
      latitude: lat,
      longitude: lng,
      distanceKm: r.distanceKm == null ? null : Math.round(r.distanceKm * 1000) / 1000,
      distanceText: r.distanceKm == null ? null : formatDistance(r.distanceKm),
      directionsUrl: origin && lat != null && lng != null ? directionsUrl(origin, { latitude: lat, longitude: lng }) : lat != null && lng != null ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : null,
      nextSlot: next.get(p.id)?.start ?? null,
      teamSize: members.filter((m) => m.profileId === p.id).length,
    };
  });
}

/** Profiles with at least one free time on an IST day, and their first such time. */
async function profilesFreeOn(profileIds: string[], dateKey: string, now: Date): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!profileIds.length) return out;
  const [profiles, members, services] = await Promise.all([
    db.select().from(consultProfiles).where(inArray(consultProfiles.id, profileIds)),
    db.select().from(consultMembers).where(and(inArray(consultMembers.profileId, profileIds), eq(consultMembers.status, "ACTIVE"))),
    db.select().from(consultServices).where(and(inArray(consultServices.profileId, profileIds), eq(consultServices.status, "ACTIVE"))),
  ]);
  const calendars = await loadCalendars(members, istAt(dateKey, 0), istAt(addDays(dateKey, 1), 0), { now });
  for (const p of profiles) {
    const pm = members.filter((m) => m.profileId === p.id);
    for (const s of services.filter((x) => x.profileId === p.id)) {
      const cals = calendars.filter((c) => membersForService(s, pm).some((m) => m.id === c.memberId));
      const day = freeSlots(cals, serviceShape(s), rulesOf(p, now), dateKey, dateKey, { limitPerDay: 1 })[dateKey] ?? [];
      if (day.length && (!out.has(p.id) || day[0].start < out.get(p.id)!)) out.set(p.id, day[0].start);
    }
  }
  return out;
}

/* --------------------------------------------------------- public profile */

export interface PublicProfile {
  profile: ConsultProfile;
  shop: { id: string; slug: string; name: string; address: string; latitude: number | null; longitude: number | null; phone: string | null; whatsapp: string | null; status: string };
  members: (Pick<ConsultMember, "id" | "name" | "title" | "photoUrl" | "qualifications" | "experienceYears" | "languages" | "bio" | "docStatus" | "color" | "registrationBody"> & { categories: string[]; days: number[] })[];
  services: ConsultService[];
  categories: ConsultCategory[];
  bookable: boolean;
}

export async function publicProfileBySlug(slug: string, options: { allowDraft?: boolean } = {}): Promise<PublicProfile> {
  const [row] = await db.select({ profile: consultProfiles, shop: shops }).from(consultProfiles).innerJoin(shops, eq(shops.id, consultProfiles.shopId)).where(eq(shops.slug, slug));
  if (!row || row.shop.deletedAt) throw notFound("Consultant");
  const bookable = row.profile.status === "LIVE" && row.profile.verification !== "REJECTED" && row.shop.status === "APPROVED";
  if (!bookable && !options.allowDraft) throw notFound("Consultant");
  const [members, services, links, hours] = await Promise.all([
    db.select().from(consultMembers).where(and(eq(consultMembers.profileId, row.profile.id), eq(consultMembers.status, "ACTIVE"))).orderBy(asc(consultMembers.sortOrder), asc(consultMembers.createdAt)),
    db.select().from(consultServices).where(and(eq(consultServices.profileId, row.profile.id), eq(consultServices.status, "ACTIVE"))).orderBy(asc(consultServices.sortOrder), asc(consultServices.createdAt)),
    db
      .select({ memberId: consultMemberCategories.memberId, category: consultCategories })
      .from(consultMemberCategories)
      .innerJoin(consultCategories, eq(consultCategories.id, consultMemberCategories.categoryId))
      .innerJoin(consultMembers, eq(consultMembers.id, consultMemberCategories.memberId))
      .where(eq(consultMembers.profileId, row.profile.id)),
    db
      .select({ memberId: consultWeeklyHours.memberId, weekday: consultWeeklyHours.weekday })
      .from(consultWeeklyHours)
      .innerJoin(consultMembers, eq(consultMembers.id, consultWeeklyHours.memberId))
      .where(eq(consultMembers.profileId, row.profile.id)),
  ]);
  const s = row.shop;
  return {
    profile: row.profile,
    shop: {
      id: s.id,
      slug: s.slug,
      name: s.name,
      address: row.profile.addressLine || [s.addressLine1, s.addressLine2, s.area, s.city, s.pincode].filter(Boolean).join(", "),
      latitude: row.profile.latitude ?? (s.latitude && new RegExp(NUMBER).test(s.latitude) ? Number(s.latitude) : null),
      longitude: row.profile.longitude ?? (s.longitude && new RegExp(NUMBER).test(s.longitude) ? Number(s.longitude) : null),
      phone: s.contactPhone,
      whatsapp: s.whatsappNumber,
      status: s.status,
    },
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      title: m.title,
      photoUrl: m.photoUrl,
      qualifications: m.qualifications,
      experienceYears: m.experienceYears,
      languages: m.languages,
      bio: m.bio,
      docStatus: m.docStatus,
      color: m.color,
      registrationBody: m.registrationBody,
      categories: links.filter((l) => l.memberId === m.id).map((l) => l.category.name),
      days: [...new Set(hours.filter((h) => h.memberId === m.id).map((h) => h.weekday))].sort(),
    })),
    services,
    categories: [...new Map(links.map((l) => [l.category.id, l.category])).values()],
    bookable,
  };
}

/** Free times for the booking screen: one service, optionally one member, a range of IST days. */
export async function publicAvailability(input: { serviceId: string; memberId?: string | null; from: string; days: number; attendees?: number }, now: Date = new Date()) {
  const [row] = await db
    .select({ service: consultServices, profile: consultProfiles, shopStatus: shops.status })
    .from(consultServices)
    .innerJoin(consultProfiles, eq(consultProfiles.id, consultServices.profileId))
    .innerJoin(shops, eq(shops.id, consultProfiles.shopId))
    .where(eq(consultServices.id, input.serviceId));
  if (!row || row.service.status !== "ACTIVE") throw notFound("Service");
  const fromKey = isDateKey(input.from) && input.from >= istDateKey(now) ? input.from : istDateKey(now);
  const toKey = addDays(fromKey, Math.max(0, Math.min(13, input.days - 1)));
  const members = membersForService(row.service, await db.select().from(consultMembers).where(eq(consultMembers.profileId, row.profile.id)));
  const calendars = await loadCalendars(members, istAt(fromKey, 0), istAt(addDays(toKey, 1), 0), { now });
  const days = freeSlots(calendars, serviceShape(row.service), rulesOf(row.profile, now), fromKey, toKey, { memberId: input.memberId, attendees: input.attendees });
  return { from: fromKey, to: toKey, days, bookable: row.profile.status === "LIVE" && row.shopStatus === "APPROVED" };
}

export async function listActiveCategories(): Promise<ConsultCategory[]> {
  return db.select().from(consultCategories).where(eq(consultCategories.status, "ACTIVE")).orderBy(asc(consultCategories.sortOrder), asc(consultCategories.name));
}
