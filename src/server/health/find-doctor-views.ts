/**
 * GoKesari Health, patient side around "Find a doctor": the doctor's public profile, the booking screen's
 * data (family member, mode, time or token day, record sharing, payment) and the confirmation page
 * (booking ID, IST time, directions, check-in QR, calendar, live queue, video join).
 *
 * A doctor page is shown only for a VERIFIED doctor at a bookable practice; it lists the doctor's other
 * verified clinics (same login). Prime clinics show their virtual number (calls tracked); Free listings
 * show the clinic's own number. Every page view is counted for the clinic's analytics (the page calls
 * prime.recordProfileView).
 */
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import QRCode from "qrcode";

import { notFound } from "@/lib/errors";
import { PRIME_TIER_LABELS, RELATION_LABELS, type PrimeTier, type Relation } from "@/lib/health/constants";
import { db } from "@/server/db";
import {
  consultBookingMembers,
  consultBookings,
  consultCategories,
  consultMemberCategories,
  consultMembers,
  consultProfiles,
  consultServices,
  consultWeeklyHours,
  healthAppointmentLinks,
  healthClinicSettings,
  healthDoctorProfiles,
  healthPatients,
  healthSuggestions,
  shops,
  type ConsultProfile,
} from "@/server/db/schema";
import { doctorStatus, requirePatientAccess, sameDoctorMemberIds, type HealthActor } from "./access";
import { checkInQrPayload, queuePosition, type QueuePosition } from "./booking";
import { doctorName, nextSlotByMember } from "./find-doctor";
import { listFamily } from "./patients";
import { primeTiersForShops } from "./prime";
import { activeVirtualNumber } from "./telephony";

const NUMBER = /^\s*-?[0-9]{1,3}(\.[0-9]+)?\s*$/;
const coord = (profileValue: number | null, shopValue: string | null) => profileValue ?? (shopValue && NUMBER.test(shopValue) ? Number(shopValue) : null);
const bookable = (p: Pick<ConsultProfile, "status" | "verification">, shopStatus: string, deletedAt: Date | null) => p.status === "LIVE" && p.verification !== "REJECTED" && shopStatus === "APPROVED" && !deletedAt;

export interface ClinicView {
  memberId: string;
  shopId: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  directionsUrl: string | null;
  phone: string | null;
  /** True when `phone` is the clinic's GoKesari virtual number (calls are tracked). */
  virtualNumber: boolean;
  whatsapp: string | null;
  tokenMode: boolean;
  tier: PrimeTier;
  primeLabel: string | null;
  hours: { weekday: number; from: number; to: number }[];
  services: { id: string; name: string; feePaise: number; feeType: string; durationMinutes: number; modes: string[]; payOnline: boolean; payAtVisit: boolean }[];
  nextSlot: string | null;
}

export interface DoctorProfileView {
  memberId: string;
  name: string;
  photoUrl: string | null;
  practitionerType: string;
  qualifications: string;
  council: string;
  registrationNumber: string;
  registrationYear: number | null;
  specialties: string[];
  experienceYears: number | null;
  languages: string[];
  bio: string | null;
  about: string | null;
  rating: number;
  ratingCount: number;
  verified: true;
  clinics: ClinicView[];
  reviews: { rating: number; text: string | null; at: string; by: string }[];
}

/** The public page of a verified doctor (404 for anyone not verified / not bookable). */
export async function doctorPublicProfile(memberId: string, now: Date = new Date()): Promise<DoctorProfileView> {
  const status = await doctorStatus(memberId);
  if (!status.isDoctor || !status.verified) throw notFound("Doctor");
  const ids = await sameDoctorMemberIds(memberId);
  const rows = await db
    .select({
      m: consultMembers,
      p: consultProfiles,
      s: shops,
      fullName: healthDoctorProfiles.fullName,
      qualifications: healthDoctorProfiles.qualifications,
      specialties: healthDoctorProfiles.specialties,
      council: healthDoctorProfiles.council,
      registrationNumber: healthDoctorProfiles.registrationNumber,
      registrationYear: healthDoctorProfiles.registrationYear,
      practitionerType: healthDoctorProfiles.practitionerType,
    })
    .from(consultMembers)
    .innerJoin(consultProfiles, eq(consultProfiles.id, consultMembers.profileId))
    .innerJoin(shops, eq(shops.id, consultMembers.shopId))
    .innerJoin(healthDoctorProfiles, eq(healthDoctorProfiles.memberId, consultMembers.id))
    .where(inArray(consultMembers.id, ids));
  const main = rows.find((r) => r.m.id === memberId);
  if (!main || !bookable(main.p, main.s.status, main.s.deletedAt)) throw notFound("Doctor");
  // Other clinics of the same doctor: only verified and bookable ones.
  const clinicsRows: typeof rows = [];
  for (const r of rows) {
    if (!bookable(r.p, r.s.status, r.s.deletedAt)) continue;
    if (r.m.id !== memberId && !(await doctorStatus(r.m.id)).verified) continue;
    clinicsRows.push(r);
  }
  clinicsRows.sort((a, b) => (a.m.id === memberId ? -1 : b.m.id === memberId ? 1 : a.s.name.localeCompare(b.s.name)));
  const memberIds = clinicsRows.map((r) => r.m.id);
  const profileIds = [...new Set(clinicsRows.map((r) => r.p.id))];
  const shopIds = [...new Set(clinicsRows.map((r) => r.s.id))];
  const [services, hours, settings, tiers, cats, reviews] = await Promise.all([
    db.select().from(consultServices).where(and(inArray(consultServices.profileId, profileIds), eq(consultServices.status, "ACTIVE"))).orderBy(asc(consultServices.sortOrder)),
    db.select().from(consultWeeklyHours).where(inArray(consultWeeklyHours.memberId, memberIds)).orderBy(asc(consultWeeklyHours.weekday), asc(consultWeeklyHours.startMinute)),
    db.select().from(healthClinicSettings).where(inArray(healthClinicSettings.shopId, shopIds)),
    primeTiersForShops(shopIds, now),
    db
      .select({ name: consultCategories.name })
      .from(consultMemberCategories)
      .innerJoin(consultCategories, eq(consultCategories.id, consultMemberCategories.categoryId))
      .where(and(eq(consultMemberCategories.memberId, memberId), eq(consultCategories.requiredDoc, "MEDICAL_REGISTRATION"))),
    db
      .select({ rating: consultBookings.rating, review: consultBookings.review, at: consultBookings.updatedAt, visitor: consultBookings.visitorName })
      .from(consultBookings)
      .innerJoin(consultBookingMembers, eq(consultBookingMembers.bookingId, consultBookings.id))
      .where(and(inArray(consultBookingMembers.memberId, memberIds), isNotNull(consultBookings.rating)))
      .orderBy(desc(consultBookings.updatedAt))
      .limit(20),
  ]);
  const next = await nextSlotByMember(
    clinicsRows.map((r) => r.m),
    new Map(clinicsRows.map((r) => [r.p.id, r.p])),
    services,
    now,
  );
  const clinics: ClinicView[] = [];
  for (const r of clinicsRows) {
    const tier = tiers.get(r.s.id);
    const t = (tier?.tier ?? "FREE") as PrimeTier;
    const vn = t !== "FREE" && tier?.features.virtualNumber ? await activeVirtualNumber(r.s.id) : null;
    const lat = coord(r.p.latitude, r.s.latitude);
    const lng = coord(r.p.longitude, r.s.longitude);
    clinics.push({
      memberId: r.m.id,
      shopId: r.s.id,
      name: r.p.displayName || r.s.name,
      address: r.p.addressLine || [r.s.addressLine1, r.s.addressLine2, r.s.area, r.s.city, r.s.pincode].filter(Boolean).join(", "),
      latitude: lat,
      longitude: lng,
      directionsUrl: lat != null && lng != null ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : null,
      phone: vn?.number ?? r.s.contactPhone ?? r.s.phone ?? null,
      virtualNumber: Boolean(vn),
      whatsapp: r.s.whatsappNumber ?? null,
      tokenMode: settings.find((x) => x.shopId === r.s.id)?.tokenMode ?? false,
      tier: t,
      primeLabel: t !== "FREE" ? PRIME_TIER_LABELS[t] : null,
      hours: hours.filter((h) => h.memberId === r.m.id).map((h) => ({ weekday: h.weekday, from: h.startMinute, to: h.endMinute })),
      services: services
        .filter((s) => s.profileId === r.p.id && (!s.memberIds.length || s.memberIds.includes(r.m.id)) && s.bookingKind !== "TEAM")
        .map((s) => ({ id: s.id, name: s.name, feePaise: s.feePaise, feeType: s.feeType, durationMinutes: s.durationMinutes, modes: s.modes, payOnline: s.payOnline, payAtVisit: s.payAtVisit })),
      nextSlot: next.get(r.m.id)?.start ?? null,
    });
  }
  const rated = reviews.filter((x) => x.rating != null);
  const avg = rated.length ? rated.reduce((n, x) => n + Number(x.rating), 0) / rated.length : main.p.ratingAvgX100 / 100;
  return {
    memberId,
    name: doctorName(main.fullName || main.m.name),
    photoUrl: main.m.photoUrl ?? main.p.photoUrl,
    practitionerType: main.practitionerType,
    qualifications: main.qualifications,
    council: main.council,
    registrationNumber: main.registrationNumber,
    registrationYear: main.registrationYear,
    specialties: [...new Set([...cats.map((c) => c.name), ...(main.specialties ?? [])])],
    experienceYears: main.m.experienceYears,
    languages: main.m.languages,
    bio: main.m.bio,
    about: main.p.about,
    rating: Math.round(avg * 10) / 10,
    ratingCount: rated.length || main.p.ratingCount,
    verified: true,
    clinics,
    // Patients are shown by first initial only.
    reviews: rated.slice(0, 10).map((x) => ({ rating: Number(x.rating), text: x.review, at: x.at.toISOString(), by: `${(x.visitor.trim()[0] ?? "P").toUpperCase()}.` })),
  };
}

/* ------------------------------------------------------------ booking screen */

export interface BookingContext {
  service: { id: string; name: string; feePaise: number; feeType: string; depositPaise: number; durationMinutes: number; modes: string[]; payOnline: boolean; payAtVisit: boolean };
  doctor: { memberId: string; name: string };
  clinic: { shopId: string; name: string; address: string };
  tokenMode: boolean;
  family: { id: string; name: string; relation: string }[];
  preselectPatientId: string | null;
  suggestionId: string | null;
}

/**
 * What the booking screen needs. The doctor must be a verified doctor who offers the service. A doctor's
 * suggestion (from a prescription) preselects that patient — only when the actor may act for them.
 */
export async function bookingContext(serviceId: string, memberId: string | null, actor: HealthActor, suggestionId: string | null = null): Promise<BookingContext> {
  const [row] = await db
    .select({ s: consultServices, p: consultProfiles, shop: shops })
    .from(consultServices)
    .innerJoin(consultProfiles, eq(consultProfiles.id, consultServices.profileId))
    .innerJoin(shops, eq(shops.id, consultServices.shopId))
    .where(eq(consultServices.id, serviceId));
  if (!row || row.s.status !== "ACTIVE" || !bookable(row.p, row.shop.status, row.shop.deletedAt)) throw notFound("Service");
  const members = await db.select().from(consultMembers).where(and(eq(consultMembers.profileId, row.p.id), eq(consultMembers.status, "ACTIVE")));
  const offering = row.s.memberIds.length ? members.filter((m) => row.s.memberIds.includes(m.id)) : members;
  const candidates = memberId ? offering.filter((m) => m.id === memberId) : offering;
  let doctor: { memberId: string; name: string } | null = null;
  for (const m of candidates) {
    if ((await doctorStatus(m.id)).verified) {
      const [dp] = await db.select({ fullName: healthDoctorProfiles.fullName }).from(healthDoctorProfiles).where(eq(healthDoctorProfiles.memberId, m.id));
      doctor = { memberId: m.id, name: doctorName(dp?.fullName ?? m.name) };
      break;
    }
  }
  if (!doctor) throw notFound("Doctor");
  const [settings] = await db.select({ tokenMode: healthClinicSettings.tokenMode }).from(healthClinicSettings).where(eq(healthClinicSettings.shopId, row.shop.id));
  const family = await listFamily(actor);
  let preselectPatientId: string | null = null;
  let validSuggestion: string | null = null;
  if (suggestionId && /^[0-9a-f-]{36}$/i.test(suggestionId)) {
    const [sg] = await db.select({ id: healthSuggestions.id, patientId: healthSuggestions.patientId, status: healthSuggestions.status }).from(healthSuggestions).where(eq(healthSuggestions.id, suggestionId));
    if (sg) {
      try {
        await requirePatientAccess(sg.patientId, actor);
        preselectPatientId = sg.patientId;
        validSuggestion = sg.status === "OPEN" ? sg.id : null;
      } catch {
        /* not this person's suggestion: ignore it */
      }
    }
  }
  return {
    service: { id: row.s.id, name: row.s.name, feePaise: row.s.feePaise, feeType: row.s.feeType, depositPaise: row.s.depositPaise, durationMinutes: row.s.durationMinutes, modes: row.s.modes, payOnline: row.s.payOnline, payAtVisit: row.s.payAtVisit },
    doctor,
    clinic: { shopId: row.shop.id, name: row.p.displayName || row.shop.name, address: row.p.addressLine || [row.shop.addressLine1, row.shop.area, row.shop.city].filter(Boolean).join(", ") },
    tokenMode: settings?.tokenMode ?? false,
    family: family.map((p) => ({ id: p.id, name: p.fullName, relation: RELATION_LABELS[p.relation as Relation] ?? p.relation })),
    preselectPatientId,
    suggestionId: validSuggestion,
  };
}

/* ------------------------------------------------------------ confirmation page */

export interface AppointmentView {
  bookingId: string;
  bookingNumber: string;
  status: string;
  mode: string;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  feePaise: number;
  paymentMode: string;
  paymentStatus: string;
  patientName: string;
  doctorNames: string[];
  clinic: { name: string; address: string; latitude: number | null; longitude: number | null; directionsUrl: string | null; phone: string | null };
  tokenNumber: number | null;
  queue: QueuePosition | null;
  meetingUrl: string | null;
  checkInQrSvg: string | null;
  shopId: string;
}

/** The patient's confirmation / appointment page (the booker, or anyone who may open that patient's record). */
export async function appointmentView(bookingId: string, actor: HealthActor): Promise<AppointmentView> {
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, bookingId));
  if (!b) throw notFound("Booking");
  const [link] = await db.select().from(healthAppointmentLinks).where(eq(healthAppointmentLinks.bookingId, b.id));
  if (b.customerId !== actor.id) {
    if (!link) throw notFound("Booking");
    await requirePatientAccess(link.patientId, actor);
  }
  const [[shop], [profile], members, patient] = await Promise.all([
    db.select().from(shops).where(eq(shops.id, b.shopId)),
    db.select().from(consultProfiles).where(eq(consultProfiles.shopId, b.shopId)),
    db
      .select({ name: consultMembers.name, fullName: healthDoctorProfiles.fullName })
      .from(consultBookingMembers)
      .innerJoin(consultMembers, eq(consultMembers.id, consultBookingMembers.memberId))
      .leftJoin(healthDoctorProfiles, eq(healthDoctorProfiles.memberId, consultMembers.id))
      .where(eq(consultBookingMembers.bookingId, b.id)),
    link ? db.select({ fullName: healthPatients.fullName }).from(healthPatients).where(eq(healthPatients.id, link.patientId)).then((r) => r[0] ?? null) : Promise.resolve(null),
  ]);
  const lat = coord(profile?.latitude ?? null, shop?.latitude ?? null);
  const lng = coord(profile?.longitude ?? null, shop?.longitude ?? null);
  const live = ["CONFIRMED", "PENDING_APPROVAL"].includes(b.status);
  let checkInQrSvg: string | null = null;
  if (live && b.mode !== "VIDEO" && b.mode !== "PHONE") {
    const payload = await checkInQrPayload(b.id, actor);
    checkInQrSvg = await QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 220 });
  }
  const queue = link?.tokenNumber != null && live ? await queuePosition(b.id, actor) : null;
  return {
    bookingId: b.id,
    bookingNumber: b.bookingNumber,
    status: b.status,
    mode: b.mode,
    serviceName: b.serviceName,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    feePaise: b.feePaise,
    paymentMode: b.paymentMode,
    paymentStatus: b.paymentStatus,
    patientName: patient?.fullName ?? b.visitorName,
    doctorNames: members.map((m) => doctorName(m.fullName ?? m.name)),
    clinic: {
      name: profile?.displayName || shop?.name || "Clinic",
      address: profile?.addressLine || (shop ? [shop.addressLine1, shop.addressLine2, shop.area, shop.city, shop.pincode].filter(Boolean).join(", ") : ""),
      latitude: lat,
      longitude: lng,
      directionsUrl: lat != null && lng != null ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : null,
      phone: shop?.contactPhone ?? shop?.phone ?? null,
    },
    tokenNumber: link?.tokenNumber ?? null,
    queue,
    meetingUrl: b.mode === "VIDEO" && live ? b.meetingUrl : null,
    checkInQrSvg,
    shopId: b.shopId,
  };
}
