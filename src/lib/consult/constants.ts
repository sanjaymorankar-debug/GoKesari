/**
 * Consultant appointments (docs/consult-booking-2026-11): the fixed vocabularies.
 * Pure data — safe on client and server. The database checks in
 * drizzle/0153_consult_bookings.sql list the same values.
 */
import { L, type Text } from "@/lib/board/i18n";

export const CONSULT_MODES = ["IN_PERSON", "VIDEO", "PHONE", "HOME_VISIT"] as const;
export type ConsultMode = (typeof CONSULT_MODES)[number];

export const CONSULT_MODE_LABELS: Record<ConsultMode, Text> = {
  IN_PERSON: L("In person", "व्यक्तिगत रूप से", "प्रत्यक्ष भेट"),
  VIDEO: L("Video call", "वीडियो कॉल", "व्हिडिओ कॉल"),
  PHONE: L("Phone call", "फ़ोन कॉल", "फोन कॉल"),
  HOME_VISIT: L("Home visit", "घर पर", "घरी भेट"),
};

export const CONSULT_BOOKING_KINDS = ["INDIVIDUAL", "TEAM", "GROUP"] as const;
export type ConsultBookingKind = (typeof CONSULT_BOOKING_KINDS)[number];
export const CONSULT_BOOKING_KIND_LABELS: Record<ConsultBookingKind, string> = {
  INDIVIDUAL: "One-to-one appointment",
  TEAM: "Team appointment (several members together)",
  GROUP: "Group session (class, workshop, family)",
};

export const CONSULT_FEE_TYPES = ["FREE", "FIXED", "DEPOSIT"] as const;
export type ConsultFeeType = (typeof CONSULT_FEE_TYPES)[number];
export const CONSULT_FEE_TYPE_LABELS: Record<ConsultFeeType, string> = {
  FREE: "Free",
  FIXED: "Fixed fee",
  DEPOSIT: "Advance now, balance later",
};

export const CONSULT_BOOKING_STATUSES = [
  "PENDING_PAYMENT",
  "PENDING_APPROVAL",
  "CONFIRMED",
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
  "NO_SHOW",
  "EXPIRED",
] as const;
export type ConsultBookingStatus = (typeof CONSULT_BOOKING_STATUSES)[number];

/** Statuses that hold calendar time. */
export const CONSULT_ACTIVE_STATUSES: readonly ConsultBookingStatus[] = ["PENDING_PAYMENT", "PENDING_APPROVAL", "CONFIRMED"];
/** Statuses that will not change again (apart from a rating or a refund settling). */
export const CONSULT_FINAL_STATUSES: readonly ConsultBookingStatus[] = ["COMPLETED", "CANCELLED", "REJECTED", "NO_SHOW", "EXPIRED"];

export const CONSULT_STATUS_LABELS: Record<ConsultBookingStatus | "RESCHEDULED", Text> = {
  PENDING_PAYMENT: L("Awaiting payment", "भुगतान बाकी", "पेमेंट बाकी"),
  PENDING_APPROVAL: L("Pending", "लंबित", "प्रलंबित"),
  CONFIRMED: L("Confirmed", "पक्का", "निश्चित"),
  COMPLETED: L("Completed", "पूरा", "पूर्ण"),
  CANCELLED: L("Cancelled", "रद्द", "रद्द"),
  REJECTED: L("Declined", "अस्वीकृत", "नाकारले"),
  NO_SHOW: L("No-show", "नहीं आए", "आले नाहीत"),
  EXPIRED: L("Lapsed", "समाप्त", "संपले"),
  RESCHEDULED: L("Rescheduled", "समय बदला", "वेळ बदलली"),
};

/**
 * Calendar colours (consultant calendar legend): pending amber, confirmed teal,
 * completed green, cancelled grey, no-show red, rescheduled violet.
 */
export const CONSULT_STATUS_TONES: Record<ConsultBookingStatus | "RESCHEDULED", { bg: string; border: string; text: string }> = {
  PENDING_PAYMENT: { bg: "bg-amber-50", border: "border-amber-400", text: "text-amber-900" },
  PENDING_APPROVAL: { bg: "bg-amber-100", border: "border-amber-500", text: "text-amber-950" },
  CONFIRMED: { bg: "bg-teal-50", border: "border-teal-500", text: "text-teal-950" },
  COMPLETED: { bg: "bg-green-50", border: "border-green-600", text: "text-green-950" },
  CANCELLED: { bg: "bg-stone-100", border: "border-stone-400", text: "text-stone-600" },
  REJECTED: { bg: "bg-stone-100", border: "border-stone-400", text: "text-stone-600" },
  NO_SHOW: { bg: "bg-red-50", border: "border-red-500", text: "text-red-900" },
  EXPIRED: { bg: "bg-stone-50", border: "border-stone-300", text: "text-stone-500" },
  RESCHEDULED: { bg: "bg-violet-50", border: "border-violet-500", text: "text-violet-950" },
};

/** The status a calendar shows: a confirmed booking that was moved shows as rescheduled. */
export function displayStatus(b: { status: ConsultBookingStatus; rescheduleCount: number }): ConsultBookingStatus | "RESCHEDULED" {
  return b.status === "CONFIRMED" && b.rescheduleCount > 0 ? "RESCHEDULED" : b.status;
}

export const CONSULT_PAYMENT_MODES = ["FREE", "ONLINE", "PAY_AT_VISIT"] as const;
export type ConsultPaymentMode = (typeof CONSULT_PAYMENT_MODES)[number];
export const CONSULT_PAYMENT_STATUSES = ["NOT_REQUIRED", "PENDING", "PART_PAID", "PAID", "DUE", "FAILED"] as const;
export type ConsultPaymentStatus = (typeof CONSULT_PAYMENT_STATUSES)[number];
export const CONSULT_PAYMENT_STATUS_LABELS: Record<ConsultPaymentStatus, string> = {
  NOT_REQUIRED: "No payment needed",
  PENDING: "Payment pending",
  PART_PAID: "Advance paid, balance due",
  PAID: "Paid",
  DUE: "Pay at visit",
  FAILED: "Payment failed",
};
export const CONSULT_REFUND_STATUSES = ["NONE", "PENDING", "PARTIAL", "REFUNDED", "FAILED"] as const;
export type ConsultRefundStatus = (typeof CONSULT_REFUND_STATUSES)[number];
export const CONSULT_REFUND_STATUS_LABELS: Record<ConsultRefundStatus, string> = {
  NONE: "No refund",
  PENDING: "Refund in progress",
  PARTIAL: "Part refunded",
  REFUNDED: "Refunded",
  FAILED: "Refund failed — our team will follow up",
};
export const CONSULT_OFFLINE_METHODS = ["CASH", "UPI", "CARD", "OTHER"] as const;
export type ConsultOfflineMethod = (typeof CONSULT_OFFLINE_METHODS)[number];

export const CONSULT_PROFILE_STATUSES = ["DRAFT", "LIVE", "PAUSED", "BLOCKED"] as const;
export type ConsultProfileStatus = (typeof CONSULT_PROFILE_STATUSES)[number];
export const CONSULT_VERIFICATION_STATUSES = ["PENDING", "VERIFIED", "REJECTED"] as const;
export type ConsultVerification = (typeof CONSULT_VERIFICATION_STATUSES)[number];

export const CONSULT_DOC_STATUSES = ["NOT_REQUIRED", "MISSING", "SUBMITTED", "VERIFIED", "REJECTED"] as const;
export type ConsultDocStatus = (typeof CONSULT_DOC_STATUSES)[number];

/** The professional registration a category asks of each consultant in it. */
export const CONSULT_REQUIRED_DOCS = ["NONE", "MEDICAL_REGISTRATION", "BAR_COUNCIL", "ICAI", "ICSI", "ICMAI", "COA", "RCI", "OTHER"] as const;
export type ConsultRequiredDoc = (typeof CONSULT_REQUIRED_DOCS)[number];
export const CONSULT_REQUIRED_DOC_LABELS: Record<ConsultRequiredDoc, string> = {
  NONE: "None",
  MEDICAL_REGISTRATION: "Medical / Dental Council registration",
  BAR_COUNCIL: "Bar Council enrolment",
  ICAI: "ICAI membership (Chartered Accountant)",
  ICSI: "ICSI membership (Company Secretary)",
  ICMAI: "ICMAI membership (Cost Accountant)",
  COA: "Council of Architecture registration",
  RCI: "Rehabilitation Council of India registration",
  OTHER: "Other professional registration",
};

export const CONSULT_TIME_OFF_KINDS = ["LEAVE", "HOLIDAY", "BLOCK", "EXTRA"] as const;
export type ConsultTimeOffKind = (typeof CONSULT_TIME_OFF_KINDS)[number];
export const CONSULT_TIME_OFF_LABELS: Record<ConsultTimeOffKind, string> = {
  LEAVE: "Leave",
  HOLIDAY: "Holiday (whole firm)",
  BLOCK: "Blocked time",
  EXTRA: "Extra hours",
};

export const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Consent wording version recorded with every booking (shown on the booking form). */
export const CONSULT_CONSENT_VERSION = "consult-2026-11-20";
export const CONSULT_CONSENT_TEXT =
  "I agree that my details, notes and any documents I attach are shared only with this consultant or firm and GoKesari support, to arrange and provide this appointment.";

export const CONSULT_BOOKING_PATH = "/consult/bookings";
export const CONSULT_SHOP_PATH = "/shop/consult";
