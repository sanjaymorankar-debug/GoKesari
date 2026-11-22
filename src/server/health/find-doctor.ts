/**
 * GoKesari Health "Find a doctor" (owner brief §2.2): one card per verified doctor per clinic.
 *
 * Search by specialty (consult categories that need a medical council registration), doctor name,
 * clinic, symptom (a small symptom → specialty table, lib/health/symptoms.ts) and area; nearby from the
 * browser's or the saved location (the same Haversine-in-SQL as Find a Consultant — no PostGIS, no
 * Google call). Filters: fee range, language, in-clinic or video, available today / this week, Prime.
 * Gender is not offered: health doctor profiles and consult members carry no gender.
 *
 * Only VERIFIED doctors are ever listed (doctorStatus: certificate verified, practice verified, doctor
 * profile filled in). Ranking: relevance — specialty / name match, distance, earliest free time, rating —
 * plus a bounded, clearly labelled Prime boost (cards say "Prime" / "Prime Plus"); Free listings are
 * never hidden. Prime Plus with "featured" also appears on the Health home strip (featuredDoctors).
 *
 * Built on the consultant engine (src/server/consult/discovery.ts, availability.ts): the same bookable
 * conditions, calendars and next-free-time logic, at doctor level instead of practice level.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { nextFreeSlot } from "@/lib/consult/slots";
import { addDays, istAt, istDateKey } from "@/lib/consult/time";
import { directionsUrl, formatDistance } from "@/lib/geo/nearby";
import { PRIME_TIER_LABELS, type PrimeTier } from "@/lib/health/constants";
import { HEALTH_SPECIALTY_GROUPS, healthGroupName } from "@/lib/health/specialties";
import { specialtiesForSymptom } from "@/lib/health/symptoms";
import { db } from "@/server/db";
import { consultCategories, consultMemberCategories, consultMembers, consultProfiles, consultServices, healthDoctorProfiles, shops, type ConsultMember, type ConsultProfile, type ConsultService } from "@/server/db/schema";
import { loadCalendars, membersForService, rulesOf, serviceShape } from "@/server/consult/availability";
import { getRule } from "@/server/services/settings";
import { doctorStatus } from "./access";
import { primeTiersForShops, type PrimeTierInfo } from "./prime";

const NUMBER = "^\\s*-?[0-9]{1,3}(\\.[0-9]+)?\\s*$";

/** The labelled Prime boost, in ranking points (relevance tops out near 100). Bounded on purpose. */
export const PRIME_BOOST: Record<PrimeTier, number> = { FREE: 0, PRIME: 12, PRIME_PLUS: 15 };

const flag = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => v === true || v === "1" || v === "true");

export const doctorSearchInput = z.object({
  q: z.string().trim().max(80).optional(),
  specialty: z.string().trim().max(80).optional(),
  /** A Health group key (src/lib/health/specialties.ts), "other" for medical categories outside them. Ignored with a specialty. */
  group: z.string().trim().max(40).optional(),
  symptom: z.string().trim().max(80).optional(),
  area: z.string().trim().max(80).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(200).optional(),
  minFee: z.coerce.number().min(0).max(1_000_000).optional(),
  maxFee: z.coerce.number().min(0).max(1_000_000).optional(),
  language: z.string().trim().max(40).optional(),
  mode: z.enum(["IN_PERSON", "VIDEO"]).optional(),
  available: z.enum(["today", "week"]).optional(),
  prime: flag,
  limit: z.coerce.number().int().min(1).max(60).default(30),
});
export type DoctorSearchInput = z.input<typeof doctorSearchInput>;

export interface DoctorCard {
  memberId: string;
  shopId: string;
  profileId: string;
  slug: string;
  name: string;
  photoUrl: string | null;
  qualifications: string;
  specialties: string[];
  categorySlugs: string[];
  experienceYears: number | null;
  languages: string[];
  clinicName: string;
  area: string;
  latitude: number | null;
  longitude: number | null;
  distanceKm: number | null;
  distanceText: string | null;
  directionsUrl: string | null;
  mapUrl: string | null;
  feeFromPaise: number | null;
  feeToPaise: number | null;
  modes: string[];
  /** The service the "Book" button opens (earliest free time, the mode asked for). */
  serviceId: string | null;
  nextSlot: string | null;
  availableToday: boolean;
  rating: number;
  ratingCount: number;
  verified: true;
  tier: PrimeTier;
  /** "Prime" / "Prime Plus" on boosted cards; null on Free listings. */
  primeLabel: string | null;
  boosted: boolean;
  featured: boolean;
  score: number;
}

const clean = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => v !== "" && v !== null && v !== undefined));
};
const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Doctor display name: "Dr <name as registered>". */
export function doctorName(fullName: string): string {
  return /^dr\.?\s/i.test(fullName.trim()) ? fullName.trim() : `Dr ${fullName.trim()}`;
}

/** The specialties offered on "Find a doctor", with the Health group each is listed under. */
export async function doctorCategories(): Promise<{ slug: string; name: string; groupName: string }[]> {
  return db
    .select({ slug: consultCategories.slug, name: consultCategories.name, groupName: consultCategories.groupName })
    .from(consultCategories)
    .where(and(eq(consultCategories.status, "ACTIVE"), eq(consultCategories.requiredDoc, "MEDICAL_REGISTRATION")))
    .orderBy(consultCategories.sortOrder, consultCategories.name);
}

interface Row {
  m: ConsultMember;
  p: ConsultProfile;
  fullName: string;
  dpQualifications: string;
  dpSpecialties: string[];
  shopName: string;
  slug: string;
  area: string | null;
  city: string;
  lat: number | null;
  lng: number | null;
  distanceKm: number | null;
}

/**
 * The search. `options.featuredOnly`: Prime Plus doctors with the "featured" feature (Health home strip).
 */
export async function searchDoctors(
  raw: unknown,
  now: Date = new Date(),
  options: { featuredOnly?: boolean } = {},
): Promise<{ results: DoctorCard[]; origin: { latitude: number; longitude: number } | null; radiusKm: number; specialties: string[]; symptomSpecialties: string[] }> {
  const input = doctorSearchInput.parse(clean(raw));
  const rule = await getRule("consultBooking");
  const radiusKm = input.radiusKm ?? rule.nearbyRadiusKm;
  const origin = input.lat != null && input.lng != null ? { latitude: input.lat, longitude: input.lng } : null;
  const lat = sql<number | null>`coalesce(${consultProfiles.latitude}, CASE WHEN ${shops.latitude} ~ ${NUMBER} THEN trim(${shops.latitude})::double precision END)`;
  const lng = sql<number | null>`coalesce(${consultProfiles.longitude}, CASE WHEN ${shops.longitude} ~ ${NUMBER} THEN trim(${shops.longitude})::double precision END)`;
  const distance = origin
    ? sql<number>`(6371 * 2 * asin(sqrt(power(sin(radians((${lat} - ${origin.latitude}) / 2)), 2) + cos(radians(${origin.latitude})) * cos(radians(${lat})) * power(sin(radians((${lng} - ${origin.longitude}) / 2)), 2))))`
    : sql<number>`NULL::double precision`;

  const symptomSpecialties = input.symptom ? specialtiesForSymptom(input.symptom) : [];
  const specialties = input.specialty ? [input.specialty] : symptomSpecialties;
  // A symptom we cannot map is searched as text.
  const text = input.q ?? (input.symptom && !symptomSpecialties.length ? input.symptom : undefined);
  // Plain words typed in the search box ("heart", "kidney stone") also find the matching specialists.
  const textSpecialties = input.q ? specialtiesForSymptom(input.q) : [];
  // Health group (owner, 21-Nov-2026): the subcategory picked before a specialty.
  const healthGroups = HEALTH_SPECIALTY_GROUPS.map((g) => g.name);
  const group = !specialties.length && input.group ? (input.group === "other" ? "other" : healthGroupName(input.group)) : null;
  const groupCondition = group === "other" ? sql` AND c.group_name NOT IN ${healthGroups}` : group ? sql` AND c.group_name = ${group}` : sql``;

  const filters: SQL[] = [
    eq(consultMembers.status, "ACTIVE"),
    eq(consultMembers.docStatus, "VERIFIED"),
    sql`${consultProfiles.status} = 'LIVE' AND ${consultProfiles.verification} = 'VERIFIED' AND ${shops.status} = 'APPROVED' AND ${shops.deletedAt} IS NULL`,
    specialties.length
      ? sql`EXISTS (SELECT 1 FROM consult_member_categories mc JOIN consult_categories c ON c.id = mc.category_id WHERE mc.member_id = ${consultMembers.id} AND c.required_doc = 'MEDICAL_REGISTRATION' AND (c.slug IN ${specialties} OR c.id::text IN ${specialties}))`
      : sql`EXISTS (SELECT 1 FROM consult_member_categories mc JOIN consult_categories c ON c.id = mc.category_id WHERE mc.member_id = ${consultMembers.id} AND c.required_doc = 'MEDICAL_REGISTRATION'${groupCondition})`,
  ];
  if (text) {
    const like = likeOf(text);
    filters.push(sql`(${consultMembers.name} ILIKE ${like} OR ${healthDoctorProfiles.fullName} ILIKE ${like} OR ${consultProfiles.displayName} ILIKE ${like} OR ${shops.name} ILIKE ${like}
      OR ${healthDoctorProfiles.qualifications} ILIKE ${like} OR array_to_string(${healthDoctorProfiles.specialties}, ' ') ILIKE ${like}
      OR EXISTS (SELECT 1 FROM consult_member_categories mc JOIN consult_categories c ON c.id = mc.category_id WHERE mc.member_id = ${consultMembers.id} AND c.name ILIKE ${like})${
        textSpecialties.length ? sql` OR EXISTS (SELECT 1 FROM consult_member_categories mc JOIN consult_categories c ON c.id = mc.category_id WHERE mc.member_id = ${consultMembers.id} AND c.slug IN ${textSpecialties})` : sql``
      })`);
  }
  if (input.area) {
    const like = likeOf(input.area);
    filters.push(sql`(${shops.area} ILIKE ${like} OR ${shops.city} ILIKE ${like} OR ${shops.pincode} = ${input.area} OR ${shops.addressLine1} ILIKE ${like} OR coalesce(${consultProfiles.addressLine}, '') ILIKE ${like})`);
  }
  if (input.language) filters.push(sql`EXISTS (SELECT 1 FROM unnest(${consultMembers.languages}) l WHERE lower(l) = lower(${input.language}))`);
  if (input.mode || input.minFee != null || input.maxFee != null) {
    const conds = [sql`s.profile_id = ${consultProfiles.id}`, sql`s.status = 'ACTIVE'`, sql`(cardinality(s.member_ids) = 0 OR ${consultMembers.id} = ANY(s.member_ids))`];
    if (input.mode) conds.push(sql`${input.mode} = ANY(s.modes)`);
    if (input.minFee != null) conds.push(sql`s.fee_paise >= ${Math.round(input.minFee * 100)}`);
    if (input.maxFee != null) conds.push(sql`s.fee_paise <= ${Math.round(input.maxFee * 100)}`);
    filters.push(sql`EXISTS (SELECT 1 FROM consult_services s WHERE ${sql.join(conds, sql` AND `)})`);
  }
  if (origin) filters.push(sql`${distance} <= ${radiusKm}`);
  if (options.featuredOnly) {
    filters.push(sql`EXISTS (SELECT 1 FROM health.prime_subscriptions ps JOIN health.prime_plans pp ON pp.id = ps.plan_id
      WHERE ps.shop_id = ${shops.id} AND ps.status IN ('ACTIVE', 'GRACE') AND ps.tier = 'PRIME_PLUS' AND coalesce((pp.features->>'featured')::boolean, false)
        AND ps.starts_at <= ${now.toISOString()}::timestamptz AND coalesce(ps.grace_until, ps.ends_at) > ${now.toISOString()}::timestamptz)`);
  }

  const rows: Row[] = (
    await db
      .select({
        m: consultMembers,
        p: consultProfiles,
        fullName: healthDoctorProfiles.fullName,
        dpQualifications: healthDoctorProfiles.qualifications,
        dpSpecialties: healthDoctorProfiles.specialties,
        shopName: shops.name,
        slug: shops.slug,
        area: shops.area,
        city: shops.city,
        lat,
        lng,
        distanceKm: distance,
      })
      .from(consultMembers)
      .innerJoin(consultProfiles, eq(consultProfiles.id, consultMembers.profileId))
      .innerJoin(shops, eq(shops.id, consultMembers.shopId))
      .innerJoin(healthDoctorProfiles, eq(healthDoctorProfiles.memberId, consultMembers.id))
      .where(and(...filters))
      .orderBy(origin ? sql`${distance} ASC NULLS LAST` : sql`${consultProfiles.ratingAvgX100} DESC, ${healthDoctorProfiles.fullName} ASC`)
      .limit(200)
  ).map((r) => ({ ...r, lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng), distanceKm: r.distanceKm == null ? null : Number(r.distanceKm) }));

  let cards = await toCards(rows, { origin, radiusKm, mode: input.mode ?? null, specialties: specialties.length ? specialties : textSpecialties, text: text ?? null, now });
  if (input.available === "today") cards = cards.filter((c) => c.availableToday);
  if (input.available === "week") cards = cards.filter((c) => c.nextSlot && new Date(c.nextSlot).getTime() < now.getTime() + 7 * 86_400_000);
  // Launch mode (primeForAll): everyone has the Prime features, so the "Prime" filter narrows nothing.
  if (input.prime && !(await getRule("health")).primeForAll) cards = cards.filter((c) => c.tier !== "FREE");
  if (options.featuredOnly) cards = cards.filter((c) => c.featured);
  cards.sort((a, b) => b.score - a.score || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || a.name.localeCompare(b.name));
  cards = cards.slice(0, input.limit);
  // Never list an unverified doctor: the full check, card by card.
  const statuses = await Promise.all(cards.map((c) => doctorStatus(c.memberId)));
  cards = cards.filter((_, i) => statuses[i].verified);
  return { results: cards, origin, radiusKm, specialties, symptomSpecialties };
}

/** Member-level rating from the patients' ratings of their bookings. */
async function memberRatings(memberIds: string[]): Promise<Map<string, { avg: number; count: number }>> {
  if (!memberIds.length) return new Map();
  const rows = await db.execute<{ member_id: string; avg: number; n: number }>(sql`
    select bm.member_id, avg(b.rating)::float as avg, count(b.rating)::int as n
      from consult_bookings b join consult_booking_members bm on bm.booking_id = b.id
     where bm.member_id in ${memberIds} and b.rating is not null
     group by bm.member_id`);
  return new Map(rows.map((r) => [r.member_id, { avg: Number(r.avg), count: Number(r.n) }]));
}

/** Earliest free time per doctor (their own calendar), across the services they offer. */
export async function nextSlotByMember(
  members: readonly ConsultMember[],
  profiles: Map<string, ConsultProfile>,
  services: readonly ConsultService[],
  now: Date,
  mode: string | null = null,
): Promise<Map<string, { start: string; serviceId: string } | null>> {
  const out = new Map<string, { start: string; serviceId: string } | null>();
  if (!members.length) return out;
  const calendars = await loadCalendars(members, now, istAt(addDays(istDateKey(now), 15), 0), { now });
  for (const m of members) {
    const profile = profiles.get(m.profileId);
    if (!profile) continue;
    const cals = calendars.filter((c) => c.memberId === m.id);
    let best: { start: string; serviceId: string } | null = null;
    for (const s of services.filter((x) => x.profileId === m.profileId && (!mode || x.modes.includes(mode as never)))) {
      if (!membersForService(s, [m]).length) continue;
      const slot = nextFreeSlot(cals, serviceShape(s), rulesOf(profile, now), 14);
      if (slot && (!best || slot.start < best.start)) best = { start: slot.start, serviceId: s.id };
    }
    out.set(m.id, best);
  }
  return out;
}

async function toCards(rows: Row[], ctx: { origin: { latitude: number; longitude: number } | null; radiusKm: number; mode: string | null; specialties: string[]; text: string | null; now: Date }): Promise<DoctorCard[]> {
  if (!rows.length) return [];
  const memberIds = rows.map((r) => r.m.id);
  const profileIds = [...new Set(rows.map((r) => r.p.id))];
  const [services, cats, tiers, ratings] = await Promise.all([
    db.select().from(consultServices).where(and(inArray(consultServices.profileId, profileIds), eq(consultServices.status, "ACTIVE"))),
    db
      .select({ memberId: consultMemberCategories.memberId, name: consultCategories.name, slug: consultCategories.slug, requiredDoc: consultCategories.requiredDoc })
      .from(consultMemberCategories)
      .innerJoin(consultCategories, eq(consultCategories.id, consultMemberCategories.categoryId))
      .where(inArray(consultMemberCategories.memberId, memberIds)),
    primeTiersForShops(rows.map((r) => r.m.shopId), ctx.now),
    memberRatings(memberIds),
  ]);
  const profiles = new Map(rows.map((r) => [r.p.id, r.p]));
  const next = await nextSlotByMember(
    rows.map((r) => r.m),
    profiles,
    services,
    ctx.now,
    ctx.mode,
  );
  const today = istDateKey(ctx.now);
  const textLower = ctx.text?.toLowerCase() ?? null;
  return rows.map((r) => {
    const offered = services.filter((s) => s.profileId === r.p.id && membersForService(s, [r.m]).length);
    const fees = offered.map((s) => s.feePaise);
    const myCats = cats.filter((c) => c.memberId === r.m.id && c.requiredDoc === "MEDICAL_REGISTRATION");
    const tier: PrimeTierInfo | undefined = tiers.get(r.m.shopId);
    const t = (tier?.tier ?? "FREE") as PrimeTier;
    const boosted = t !== "FREE" && tier?.features.priorityPlacement !== false;
    const slot = next.get(r.m.id) ?? null;
    const rate = ratings.get(r.m.id);
    const rating = rate?.count ? rate.avg : r.p.ratingAvgX100 / 100;
    const ratingCount = rate?.count ? rate.count : r.p.ratingCount;
    const name = doctorName(r.fullName || r.m.name);
    // Relevance (never more than ~100), then the labelled Prime boost.
    let score = 0;
    if (ctx.specialties.length && myCats.some((c) => ctx.specialties.includes(c.slug))) score += 30 - Math.max(0, ctx.specialties.indexOf(myCats.find((c) => ctx.specialties.includes(c.slug))!.slug)) * 5;
    if (textLower && (name.toLowerCase().includes(textLower) || r.shopName.toLowerCase().includes(textLower))) score += 10;
    if (ctx.origin && r.distanceKm != null) score += 25 * Math.max(0, 1 - r.distanceKm / ctx.radiusKm);
    if (slot) {
      const ms = new Date(slot.start).getTime() - ctx.now.getTime();
      score += istDateKey(new Date(slot.start)) === today ? 15 : ms < 7 * 86_400_000 ? 8 : 3;
    }
    if (ratingCount) score += (rating / 5) * 10 * Math.min(1, ratingCount / 5);
    if (boosted) score += PRIME_BOOST[t];
    const specialtiesShown = [...new Set([...myCats.map((c) => c.name), ...(r.dpSpecialties ?? [])])];
    return {
      memberId: r.m.id,
      shopId: r.m.shopId,
      profileId: r.p.id,
      slug: r.slug,
      name,
      photoUrl: r.m.photoUrl ?? r.p.photoUrl,
      qualifications: r.dpQualifications || r.m.qualifications || "",
      specialties: specialtiesShown,
      categorySlugs: myCats.map((c) => c.slug),
      experienceYears: r.m.experienceYears,
      languages: r.m.languages,
      clinicName: r.p.displayName || r.shopName,
      area: [r.area, r.city].filter(Boolean).join(", "),
      latitude: r.lat,
      longitude: r.lng,
      distanceKm: r.distanceKm == null ? null : Math.round(r.distanceKm * 1000) / 1000,
      distanceText: r.distanceKm == null ? null : formatDistance(r.distanceKm),
      directionsUrl: r.lat != null && r.lng != null ? (ctx.origin ? directionsUrl(ctx.origin, { latitude: r.lat, longitude: r.lng }) : `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}`) : null,
      mapUrl: r.lat != null && r.lng != null ? `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}` : null,
      feeFromPaise: fees.length ? Math.min(...fees) : null,
      feeToPaise: fees.length ? Math.max(...fees) : null,
      modes: [...new Set(offered.flatMap((s) => s.modes))],
      serviceId: slot?.serviceId ?? offered.find((s) => !ctx.mode || s.modes.includes(ctx.mode as never))?.id ?? null,
      nextSlot: slot?.start ?? null,
      availableToday: Boolean(slot && istDateKey(new Date(slot.start)) === today),
      rating: Math.round(rating * 10) / 10,
      ratingCount,
      verified: true as const,
      tier: t,
      primeLabel: boosted ? PRIME_TIER_LABELS[t] : null,
      boosted,
      featured: t === "PRIME_PLUS" && Boolean(tier?.features.featured),
      score: Math.round(score * 10) / 10,
    };
  });
}

/** Prime Plus "featured" doctors for the GoKesari Health home strip (nearest first when a location is known). */
export async function featuredDoctors(options: { lat?: number | null; lng?: number | null; limit?: number } = {}, now: Date = new Date()): Promise<DoctorCard[]> {
  const geo = options.lat != null && options.lng != null ? { lat: options.lat, lng: options.lng, radiusKm: 50 } : {};
  const { results } = await searchDoctors({ ...geo, limit: options.limit ?? 12 }, now, { featuredOnly: true });
  return results;
}
