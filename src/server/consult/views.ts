/**
 * Consultant appointments: what each side sees (docs/consult-booking-2026-11).
 * Private details (notes, files, contact) go only to the customer, the firm
 * (owner / assigned member) and authorised staff; every look by the firm or
 * staff at a sensitive booking is logged.
 */
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { CONSULT_ACTIVE_STATUSES, type ConsultBookingStatus } from "@/lib/consult/constants";
import { gstInclusiveSplit, policySummary, type PolicyShape } from "@/lib/consult/policy";
import { utilisationPct } from "@/lib/consult/slots";
import { addDays, istAt, istDateKey } from "@/lib/consult/time";
import { notFound } from "@/lib/errors";
import { db } from "@/server/db";
import {
  consultBookingEvents,
  consultBookingFiles,
  consultBookingMembers,
  consultBookings,
  consultCategories,
  consultMembers,
  consultProfiles,
  consultTimeOff,
  consultWeeklyHours,
  shops,
  type ConsultBooking,
} from "@/server/db/schema";
import { bookingViewer, logPrivateAccess, requireFirmAccess, type BookingViewer, type ConsultActor, type FirmAccess } from "./access";
import { loadCalendars } from "./availability";
import { completionNeedsCode } from "./bookings";
import { completionCode } from "./otp";
import { refundStateOf, type RefundState } from "./payments";

export interface BookingCard {
  id: string;
  bookingNumber: string;
  status: ConsultBookingStatus;
  rescheduleCount: number;
  startsAt: string;
  endsAt: string;
  mode: string;
  bookingKind: string;
  serviceName: string;
  visitorName: string;
  attendees: number;
  firmName: string;
  firmSlug: string;
  members: { id: string; name: string; color: string }[];
  feePaise: number;
  paidOnlinePaise: number;
  paidOfflinePaise: number;
  refundPaise: number;
  paymentStatus: string;
  paymentMode: string;
  arrived: boolean;
}

async function cards(rows: ConsultBooking[]): Promise<BookingCard[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const profileIds = [...new Set(rows.map((r) => r.profileId))];
  const [members, firms] = await Promise.all([
    db
      .select({ bookingId: consultBookingMembers.bookingId, id: consultMembers.id, name: consultMembers.name, color: consultMembers.color, active: consultBookingMembers.active })
      .from(consultBookingMembers)
      .innerJoin(consultMembers, eq(consultMembers.id, consultBookingMembers.memberId))
      .where(inArray(consultBookingMembers.bookingId, ids)),
    db.select({ id: consultProfiles.id, name: consultProfiles.displayName, slug: shops.slug }).from(consultProfiles).innerJoin(shops, eq(shops.id, consultProfiles.shopId)).where(inArray(consultProfiles.id, profileIds)),
  ]);
  return rows.map((b) => {
    const mine = members.filter((m) => m.bookingId === b.id);
    // A finished booking's members are inactive; show the latest assignment.
    const shown = mine.some((m) => m.active) ? mine.filter((m) => m.active) : mine.slice(-Math.max(1, mine.filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i).length));
    const unique = shown.filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i);
    const firm = firms.find((f) => f.id === b.profileId);
    return {
      id: b.id,
      bookingNumber: b.bookingNumber,
      status: b.status,
      rescheduleCount: b.rescheduleCount,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      mode: b.mode,
      bookingKind: b.bookingKind,
      serviceName: b.serviceName,
      visitorName: b.visitorName,
      attendees: b.attendees,
      firmName: firm?.name ?? "",
      firmSlug: firm?.slug ?? "",
      members: unique.map((m) => ({ id: m.id, name: m.name, color: m.color })),
      feePaise: b.feePaise,
      paidOnlinePaise: b.paidOnlinePaise,
      paidOfflinePaise: b.paidOfflinePaise,
      refundPaise: b.refundPaise,
      paymentStatus: b.paymentStatus,
      paymentMode: b.paymentMode,
      arrived: Boolean(b.arrivedAt),
    };
  });
}

/* ---------------------------------------------------------------- customer */

export async function customerBookings(customerId: string): Promise<{ upcoming: BookingCard[]; past: BookingCard[] }> {
  const rows = await db.select().from(consultBookings).where(eq(consultBookings.customerId, customerId)).orderBy(desc(consultBookings.startsAt)).limit(200);
  const now = Date.now();
  const all = await cards(rows);
  const upcoming = all.filter((c) => (CONSULT_ACTIVE_STATUSES as readonly string[]).includes(c.status) && new Date(c.endsAt).getTime() > now - 3_600_000).reverse();
  const past = all.filter((c) => !upcoming.includes(c));
  return { upcoming, past };
}

/* ------------------------------------------------------------------ detail */

export interface BookingDetail {
  viewer: BookingViewer;
  card: BookingCard;
  booking: {
    visitorPhone: string | null;
    visitorEmail: string | null;
    visitorAge: number | null;
    customerNote: string | null;
    privateNote: string | null;
    visitAddress: string | null;
    meetingUrl: string | null;
    feeType: string;
    onlineDuePaise: number;
    duePaise: number;
    receiptNumber: string | null;
    gstRateBp: number;
    offlineMethod: string | null;
    cancelReason: string | null;
    cancelledBy: string | null;
    rating: number | null;
    review: string | null;
    ticketId: string | null;
    holdExpiresAt: string | null;
    policy: string[];
    policyShape: PolicyShape;
    commissionPaise: number;
    anyMember: boolean;
    serviceId: string;
    profileId: string;
    shopId: string;
  };
  firm: { name: string; slug: string; address: string; latitude: number | null; longitude: number | null; phone: string | null };
  completionCode: string | null;
  completionNeedsCode: boolean;
  refund: RefundState;
  files: { id: string; fileName: string; size: number; side: string; createdAt: string }[];
  events: { kind: string; from: string | null; to: string | null; note: string | null; at: string; by: string | null }[];
  can: {
    cancel: boolean;
    reschedule: boolean;
    payBalance: boolean;
    payNow: boolean;
    rate: boolean;
    dispute: boolean;
    accept: boolean;
    arrive: boolean;
    complete: boolean;
    noShow: boolean;
    markPaid: boolean;
    note: boolean;
    upload: boolean;
    reassign: boolean;
  };
  team: { id: string; name: string }[];
}

export async function bookingDetail(bookingId: string, actor: ConsultActor, ip?: string | null): Promise<BookingDetail> {
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, bookingId));
  if (!b) throw notFound("Booking");
  const { viewer, firm } = await bookingViewer(b, actor);
  const [card] = await cards([b]);
  const [profile] = await db.select().from(consultProfiles).where(eq(consultProfiles.id, b.profileId));
  const [shop] = await db.select().from(shops).where(eq(shops.id, b.shopId));
  const [category] = b.categoryId ? await db.select({ sensitive: consultCategories.sensitive }).from(consultCategories).where(eq(consultCategories.id, b.categoryId)) : [];
  const [files, events, refund, needsCode, team] = await Promise.all([
    db.select({ id: consultBookingFiles.id, fileName: consultBookingFiles.fileName, size: consultBookingFiles.sizeBytes, side: consultBookingFiles.uploaderSide, createdAt: consultBookingFiles.createdAt }).from(consultBookingFiles).where(eq(consultBookingFiles.bookingId, b.id)).orderBy(asc(consultBookingFiles.createdAt)),
    db.select().from(consultBookingEvents).where(eq(consultBookingEvents.bookingId, b.id)).orderBy(asc(consultBookingEvents.createdAt)),
    refundStateOf(b),
    completionNeedsCode(b),
    db.select({ id: consultMembers.id, name: consultMembers.name }).from(consultMembers).where(and(eq(consultMembers.profileId, b.profileId), eq(consultMembers.status, "ACTIVE"))).orderBy(asc(consultMembers.sortOrder)),
  ]);
  if (viewer !== "CUSTOMER" && (category?.sensitive || b.customerNote || files.length)) {
    await logPrivateAccess({ bookingId: b.id, actor, action: viewer === "STAFF" ? "STAFF_VIEWED_BOOKING" : "FIRM_VIEWED_BOOKING", ipAddress: ip ?? null });
  }
  const policy = b.policy as PolicyShape;
  const now = Date.now();
  const upcoming = b.status === "CONFIRMED" || b.status === "PENDING_APPROVAL";
  const due = Math.max(0, b.feePaise - b.paidOnlinePaise - b.paidOfflinePaise);
  const firmSide = viewer !== "CUSTOMER" || Boolean(firm);
  const isCustomer = b.customerId === actor.id;
  return {
    viewer,
    card,
    booking: {
      visitorPhone: b.visitorPhone,
      visitorEmail: b.visitorEmail,
      visitorAge: b.visitorAge,
      customerNote: b.customerNote,
      privateNote: viewer === "CUSTOMER" && !firm ? null : b.privateNote,
      visitAddress: b.visitAddress,
      meetingUrl: b.status === "CONFIRMED" || b.status === "COMPLETED" || viewer !== "CUSTOMER" ? b.meetingUrl : null,
      feeType: b.feeType,
      onlineDuePaise: b.onlineDuePaise,
      duePaise: due,
      receiptNumber: b.receiptNumber,
      gstRateBp: b.gstRateBp,
      offlineMethod: b.offlineMethod,
      cancelReason: b.cancelReason,
      cancelledBy: b.cancelledBy,
      rating: b.rating,
      review: b.review,
      ticketId: b.ticketId,
      holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null,
      policy: policySummary(policy),
      policyShape: policy,
      commissionPaise: viewer === "CUSTOMER" && !firm ? 0 : b.commissionPaise,
      anyMember: b.anyMember,
      serviceId: b.serviceId,
      profileId: b.profileId,
      shopId: b.shopId,
    },
    firm: {
      name: profile?.displayName ?? shop?.name ?? "",
      slug: shop?.slug ?? "",
      address: profile?.addressLine || [shop?.addressLine1, shop?.addressLine2, shop?.area, shop?.city, shop?.pincode].filter(Boolean).join(", "),
      latitude: profile?.latitude ?? (shop?.latitude ? Number(shop.latitude) : null),
      longitude: profile?.longitude ?? (shop?.longitude ? Number(shop.longitude) : null),
      phone: shop?.contactPhone ?? null,
    },
    completionCode: isCustomer && b.status === "CONFIRMED" && needsCode && b.otpSalt ? completionCode(b.id, b.otpSalt) : null,
    completionNeedsCode: needsCode,
    refund,
    files: files.map((f) => ({ id: f.id, fileName: f.fileName, size: f.size, side: f.side, createdAt: f.createdAt.toISOString() })),
    events: events.map((e) => ({ kind: e.kind, from: e.fromStatus, to: e.toStatus, note: viewer === "CUSTOMER" && !firm && e.kind === "PRIVATE_NOTE" ? null : e.note, at: e.createdAt.toISOString(), by: e.actorRole })),
    can: {
      cancel: (CONSULT_ACTIVE_STATUSES as readonly string[]).includes(b.status) && (firmSide || b.startsAt.getTime() > now),
      reschedule: upcoming && (firmSide || (b.rescheduleCount < policy.maxReschedules && b.startsAt.getTime() - now >= policy.rescheduleMinHours * 3_600_000)),
      payBalance: isCustomer && due > 0 && b.paidOnlinePaise > 0 && ["CONFIRMED", "PENDING_APPROVAL", "COMPLETED"].includes(b.status),
      payNow: isCustomer && b.status === "PENDING_PAYMENT" && Boolean(b.holdExpiresAt && b.holdExpiresAt.getTime() > now),
      rate: isCustomer && b.status === "COMPLETED" && !b.rating,
      dispute: isCustomer && !b.ticketId && ["CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELLED", "REJECTED"].includes(b.status),
      accept: firmSide && b.status === "PENDING_APPROVAL",
      arrive: firmSide && b.status === "CONFIRMED" && !b.arrivedAt && b.mode !== "VIDEO" && b.mode !== "PHONE",
      complete: firmSide && b.status === "CONFIRMED" && now >= b.startsAt.getTime() - 15 * 60_000,
      noShow: firmSide && b.status === "CONFIRMED" && now >= b.startsAt.getTime(),
      markPaid: firmSide && due > 0 && !["CANCELLED", "REJECTED", "EXPIRED", "PENDING_PAYMENT"].includes(b.status),
      note: firmSide,
      upload: (isCustomer || firmSide) && !["EXPIRED"].includes(b.status),
      reassign: Boolean(firm && (firm.role === "OWNER" || firm.role === "STAFF")) && upcoming && b.bookingKind !== "TEAM",
    },
    team: firmSide ? team : [],
  };
}

/* ---------------------------------------------------------------- receipts */

export interface ReceiptView {
  title: "Tax invoice" | "Receipt";
  number: string;
  issuedAt: string;
  firm: { name: string; legalName: string; address: string; gstin: string | null; stateCode: string | null };
  customer: { name: string; phone: string | null; email: string | null };
  booking: { number: string; service: string; when: string; mode: string; sac: string | null };
  lines: { label: string; amountPaise: number }[];
  split: ReturnType<typeof gstInclusiveSplit> | null;
  paidOnlinePaise: number;
  paidOfflinePaise: number;
  refundPaise: number;
  duePaise: number;
}

export async function receiptView(bookingId: string, actor: ConsultActor): Promise<ReceiptView | null> {
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, bookingId));
  if (!b) return null;
  await bookingViewer(b, actor);
  if (!b.receiptNumber) return null;
  const [shop] = await db.select().from(shops).where(eq(shops.id, b.shopId));
  const [profile] = await db.select().from(consultProfiles).where(eq(consultProfiles.id, b.profileId));
  const [category] = b.categoryId ? await db.select({ sac: consultCategories.sacCode }).from(consultCategories).where(eq(consultCategories.id, b.categoryId)) : [];
  const gst = shop.gstRegistrationType === "REGULAR" && Boolean(shop.gstin) && b.gstRateBp > 0;
  const received = b.paidOnlinePaise + b.paidOfflinePaise;
  return {
    title: gst ? "Tax invoice" : "Receipt",
    number: b.receiptNumber,
    issuedAt: (b.receiptIssuedAt ?? b.createdAt).toISOString(),
    firm: {
      name: profile?.displayName ?? shop.name,
      legalName: shop.legalBusinessName ?? shop.name,
      address: [shop.addressLine1, shop.addressLine2, shop.area, shop.city, shop.state, shop.pincode].filter(Boolean).join(", "),
      gstin: gst ? shop.gstin : null,
      stateCode: shop.gstStateCode ?? null,
    },
    customer: { name: b.visitorName, phone: b.visitorPhone, email: b.visitorEmail },
    booking: { number: b.bookingNumber, service: b.serviceName, when: b.startsAt.toISOString(), mode: b.mode, sac: category?.sac ?? null },
    lines: [{ label: `${b.serviceName}${b.attendees > 1 && b.bookingKind === "GROUP" ? ` × ${b.attendees}` : ""}`, amountPaise: b.feePaise }],
    split: gst ? gstInclusiveSplit(b.feePaise, b.gstRateBp) : null,
    paidOnlinePaise: b.paidOnlinePaise,
    paidOfflinePaise: b.paidOfflinePaise,
    refundPaise: b.refundPaise,
    duePaise: Math.max(0, b.feePaise - received),
  };
}

/* -------------------------------------------------------- firm: calendar */

export interface CalendarView {
  access: FirmAccess;
  firm: { id: string; profileId: string; name: string; status: string; verification: string };
  members: { id: string; name: string; color: string; hours: { weekday: number; startMinute: number; endMinute: number }[] }[];
  bookings: BookingCard[];
  timeOff: { id: string; memberId: string | null; kind: string; startsAt: string; endsAt: string; reason: string | null }[];
  from: string;
  to: string;
}

/** Bookings of a firm between two IST days (a MEMBER sees only their own). */
export async function firmCalendar(shopId: string, actor: ConsultActor, fromKey: string, toKey: string, memberFilter?: string | null): Promise<CalendarView> {
  const access = await requireFirmAccess(shopId, actor, "bookings");
  const [profile] = await db.select().from(consultProfiles).where(eq(consultProfiles.shopId, shopId));
  if (!profile) throw notFound("Booking profile");
  const from = istAt(fromKey, 0);
  const to = istAt(addDays(toKey, 1), 0);
  const allMembers = await db.select().from(consultMembers).where(eq(consultMembers.profileId, profile.id)).orderBy(asc(consultMembers.sortOrder), asc(consultMembers.createdAt));
  const visible = access.role === "MEMBER" ? allMembers.filter((m) => m.id === access.memberId) : memberFilter ? allMembers.filter((m) => m.id === memberFilter) : allMembers;
  const memberIds = visible.map((m) => m.id);
  const bookingIds = memberIds.length
    ? await db
        .selectDistinct({ id: consultBookingMembers.bookingId })
        .from(consultBookingMembers)
        .innerJoin(consultBookings, eq(consultBookings.id, consultBookingMembers.bookingId))
        .where(and(inArray(consultBookingMembers.memberId, memberIds), gte(consultBookings.startsAt, from), lt(consultBookings.startsAt, to)))
    : [];
  const rows = bookingIds.length ? await db.select().from(consultBookings).where(inArray(consultBookings.id, bookingIds.map((r) => r.id))).orderBy(asc(consultBookings.startsAt)) : [];
  const [hours, timeOff] = await Promise.all([
    memberIds.length ? db.select().from(consultWeeklyHours).where(inArray(consultWeeklyHours.memberId, memberIds)) : [],
    db.select().from(consultTimeOff).where(and(eq(consultTimeOff.profileId, profile.id), lt(consultTimeOff.startsAt, to), sql`${consultTimeOff.endsAt} > ${from.toISOString()}::timestamptz`)),
  ]);
  return {
    access,
    firm: { id: shopId, profileId: profile.id, name: profile.displayName, status: profile.status, verification: profile.verification },
    members: visible.filter((m) => m.status === "ACTIVE" || rows.length).map((m) => ({ id: m.id, name: m.name, color: m.color, hours: hours.filter((h) => h.memberId === m.id).map((h) => ({ weekday: h.weekday, startMinute: h.startMinute, endMinute: h.endMinute })) })),
    bookings: await cards(rows.filter((r) => r.status !== "EXPIRED")),
    timeOff: timeOff
      .filter((t) => access.role !== "MEMBER" || t.memberId === null || t.memberId === access.memberId)
      .map((t) => ({ id: t.id, memberId: t.memberId, kind: t.kind, startsAt: t.startsAt.toISOString(), endsAt: t.endsAt.toISOString(), reason: t.reason })),
    from: fromKey,
    to: toKey,
  };
}

export interface FirmDashboard {
  today: BookingCard[];
  upcomingCount: number;
  pendingApproval: number;
  todayEarningsPaise: number;
  weekEarningsPaise: number;
  utilisationPct: number;
  completedThisMonth: number;
  noShowsThisMonth: number;
  ratingAvg: number;
  ratingCount: number;
}

export async function firmDashboard(shopId: string, actor: ConsultActor, now: Date = new Date()): Promise<FirmDashboard> {
  const access = await requireFirmAccess(shopId, actor, "bookings");
  const [profile] = await db.select().from(consultProfiles).where(eq(consultProfiles.shopId, shopId));
  const today = istDateKey(now);
  const cal = await firmCalendar(shopId, actor, today, today);
  const weekFrom = istAt(addDays(today, -6), 0);
  const monthFrom = istAt(`${today.slice(0, 7)}-01`, 0);
  const memberIds = cal.members.map((m) => m.id);
  const scoped = access.role === "MEMBER" && memberIds.length ? sql`${consultBookings.id} in (select booking_id from consult_booking_members where member_id = ${memberIds[0]})` : sql`true`;
  const [agg] = await db
    .select({
      upcoming: sql<number>`count(*) filter (where ${consultBookings.status} in ('CONFIRMED','PENDING_APPROVAL') and ${consultBookings.startsAt} > ${now.toISOString()}::timestamptz)::int`,
      pending: sql<number>`count(*) filter (where ${consultBookings.status} = 'PENDING_APPROVAL')::int`,
      todayMoney: sql<number>`coalesce(sum(${consultBookings.paidOnlinePaise} + ${consultBookings.paidOfflinePaise} - ${consultBookings.refundPaise}) filter (where ${consultBookings.startsAt} >= ${istAt(today, 0).toISOString()}::timestamptz and ${consultBookings.startsAt} < ${istAt(addDays(today, 1), 0).toISOString()}::timestamptz and ${consultBookings.status} in ('CONFIRMED','COMPLETED','NO_SHOW','PENDING_APPROVAL')), 0)::bigint`,
      weekMoney: sql<number>`coalesce(sum(${consultBookings.paidOnlinePaise} + ${consultBookings.paidOfflinePaise} - ${consultBookings.refundPaise}) filter (where ${consultBookings.startsAt} >= ${weekFrom.toISOString()}::timestamptz and ${consultBookings.startsAt} < ${istAt(addDays(today, 1), 0).toISOString()}::timestamptz and ${consultBookings.status} in ('CONFIRMED','COMPLETED','NO_SHOW','PENDING_APPROVAL','CANCELLED')), 0)::bigint`,
      completed: sql<number>`count(*) filter (where ${consultBookings.status} = 'COMPLETED' and ${consultBookings.startsAt} >= ${monthFrom.toISOString()}::timestamptz)::int`,
      noShows: sql<number>`count(*) filter (where ${consultBookings.status} = 'NO_SHOW' and ${consultBookings.startsAt} >= ${monthFrom.toISOString()}::timestamptz)::int`,
    })
    .from(consultBookings)
    .where(and(eq(consultBookings.shopId, shopId), scoped));
  const members = memberIds.length ? await db.select().from(consultMembers).where(inArray(consultMembers.id, memberIds)) : [];
  const calendars = await loadCalendars(members, istAt(addDays(today, -6), 0), istAt(addDays(today, 1), 0), { now });
  return {
    today: cal.bookings,
    upcomingCount: Number(agg?.upcoming ?? 0),
    pendingApproval: Number(agg?.pending ?? 0),
    todayEarningsPaise: Number(agg?.todayMoney ?? 0),
    weekEarningsPaise: Number(agg?.weekMoney ?? 0),
    utilisationPct: utilisationPct(calendars, addDays(today, -6), today),
    completedThisMonth: Number(agg?.completed ?? 0),
    noShowsThisMonth: Number(agg?.noShows ?? 0),
    ratingAvg: (profile?.ratingAvgX100 ?? 0) / 100,
    ratingCount: profile?.ratingCount ?? 0,
  };
}

/** Bookings needing the firm's attention now (approval requests), for the shop board count. */
export async function firmPendingCount(shopId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(consultBookings).where(and(eq(consultBookings.shopId, shopId), eq(consultBookings.status, "PENDING_APPROVAL")));
  return Number(r?.n ?? 0);
}

export { cards as bookingCards };
