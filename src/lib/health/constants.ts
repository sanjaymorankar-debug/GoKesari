/**
 * GoKesari Health (docs/health/): fixed vocabularies, safe on client and server.
 * drizzle/0153_health.sql checks the same values.
 */
export const HEALTH_PATH = "/health";
export const HEALTH_DOCTOR_PATH = "/shop/health";
export const HEALTH_ADMIN_PATH = "/admin/health";

export const RELATIONS = ["SELF", "CHILD", "PARENT", "SPOUSE", "SIBLING", "GRANDPARENT", "OTHER"] as const;
export type Relation = (typeof RELATIONS)[number];
export const RELATION_LABELS: Record<Relation, string> = {
  SELF: "Myself",
  CHILD: "Child",
  PARENT: "Parent",
  SPOUSE: "Spouse",
  SIBLING: "Brother / sister",
  GRANDPARENT: "Grandparent",
  OTHER: "Other family member",
};

export const GENDERS = ["FEMALE", "MALE", "OTHER"] as const;
export type Gender = (typeof GENDERS)[number];
export const GENDER_LABELS: Record<Gender, string> = { FEMALE: "Female", MALE: "Male", OTHER: "Other" };

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

/** Version of the My Health notice (DPDP Act 2023 / DPDP Rules 2025). Recorded with the patient's acceptance. */
export const HEALTH_NOTICE_VERSION = "health-notice-2026-11-20";
export const HEALTH_NOTICE_POINTS: readonly { heading: string; text: string }[] = [
  {
    heading: "What we keep",
    text: "Your health profile (date of birth, gender, blood group, allergies, conditions, medicines, emergency contact), your appointments, consultations, diagnoses, prescriptions, reports you or your providers add, medicine orders, home-care visit notes and equipment rentals — from today onwards.",
  },
  {
    heading: "Why",
    text: "To book and run your appointments and orders, to give your doctors and care providers the information you choose to share, to send you prescriptions and reminders, and to keep the records the law requires.",
  },
  {
    heading: "Who can see it",
    text: "You, and the family members you manage. A doctor sees their own consultations with you, and your earlier records only while you allow it. A medical store sees only the prescription you send it. GoKesari staff see no clinical details except in an emergency, with a reason that is logged and shown to you.",
  },
  {
    heading: "Your rights",
    text: "See who opened your records (access log), withdraw any sharing at any time, download all your data, correct your profile, and ask us to delete your account. Prescriptions and consultation notes are kept for at least 3 years as medical law requires, hidden from your view after deletion.",
  },
  {
    heading: "Complaints",
    text: "Write to the GoKesari Grievance Officer from Help → Grievance. You may also approach the Data Protection Board of India.",
  },
];

export const CONSENT_KINDS = ["HEALTH_NOTICE", "DOCTOR_RECORDS", "PROVIDER_RECORDS", "REFERRAL_RECORDS", "FAMILY_LINK"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
export const CONSENT_MODES = ["ALWAYS", "ASK", "OFF", "THIS_BOOKING"] as const;
export type ConsentMode = (typeof CONSENT_MODES)[number];

/** The record-sharing choice on a booking. */
export const SHARE_CHOICES = ["ON", "OFF", "ASK"] as const;
export type ShareChoice = (typeof SHARE_CHOICES)[number];
export const SHARE_CHOICE_LABELS: Record<ShareChoice, string> = {
  ON: "Yes — this doctor may see my earlier GoKesari records",
  OFF: "No — only what I tell the doctor at this visit",
  ASK: "Ask me each time",
};
export const RECORD_SHARE_CONSENT_VERSION = "health-share-2026-11-20";

export const ACCESS_ACTIONS = ["VIEW", "PRINT", "DOWNLOAD", "SHARE", "EXPORT", "BREAK_GLASS", "CONSENT_GRANTED", "CONSENT_REVOKED", "UPDATE"] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export const PRACTITIONER_TYPES = ["DOCTOR", "DENTIST", "AYUSH"] as const;
export type PractitionerType = (typeof PRACTITIONER_TYPES)[number];

/** Medical councils (NMC and the state councils, Dental Council, AYUSH boards). */
export const MEDICAL_COUNCILS = [
  "National Medical Commission (NMC)",
  "Andhra Pradesh Medical Council",
  "Arunachal Pradesh Medical Council",
  "Assam Medical Council",
  "Bihar Medical Council",
  "Chhattisgarh Medical Council",
  "Delhi Medical Council",
  "Goa Medical Council",
  "Gujarat Medical Council",
  "Haryana Medical Council",
  "Himachal Pradesh Medical Council",
  "Jammu & Kashmir Medical Council",
  "Jharkhand Medical Council",
  "Karnataka Medical Council",
  "Travancore-Cochin Medical Council (Kerala)",
  "Madhya Pradesh Medical Council",
  "Maharashtra Medical Council",
  "Manipur Medical Council",
  "Meghalaya Medical Council",
  "Mizoram Medical Council",
  "Nagaland Medical Council",
  "Odisha Council of Medical Registration",
  "Punjab Medical Council",
  "Rajasthan Medical Council",
  "Sikkim Medical Council",
  "Tamil Nadu Medical Council",
  "Telangana State Medical Council",
  "Tripura State Medical Council",
  "Uttar Pradesh Medical Council",
  "Uttarakhand Medical Council",
  "West Bengal Medical Council",
  "Dental Council of India / State Dental Council",
  "Maharashtra State Dental Council",
  "Maharashtra Council of Indian Medicine (Ayurveda / Unani)",
  "Maharashtra Council of Homoeopathy",
  "Other State Board of AYUSH / Homoeopathy",
] as const;

export const DRUG_FORMS = [
  "TABLET",
  "CAPSULE",
  "SYRUP",
  "SUSPENSION",
  "INJECTION",
  "OINTMENT",
  "CREAM",
  "GEL",
  "DROPS",
  "INHALER",
  "POWDER",
  "SACHET",
  "SPRAY",
  "SUPPOSITORY",
  "PATCH",
  "LOTION",
  "SOLUTION",
  "OTHER",
] as const;
export type DrugForm = (typeof DRUG_FORMS)[number];
export const DRUG_SCHEDULES = ["OTC", "G", "H", "H1", "X", "NDPS"] as const;
export type DrugSchedule = (typeof DRUG_SCHEDULES)[number];

/** Telemedicine Practice Guidelines 2020 medicine lists. */
export const TELE_LISTS = ["O", "A", "B", "PROHIBITED"] as const;
export type TeleList = (typeof TELE_LISTS)[number];
export const TELE_LIST_LABELS: Record<TeleList, string> = {
  O: "List O — may be prescribed by any mode",
  A: "List A — may be prescribed on a first video consultation",
  B: "List B — by video only as a follow-up of an in-person consultation",
  PROHIBITED: "Prohibited — never by teleconsultation (Schedule X / NDPS)",
};

export const RX_TIMINGS = ["BEFORE_FOOD", "AFTER_FOOD", "WITH_FOOD", "EMPTY_STOMACH", "BEDTIME", "AS_NEEDED", "ANY_TIME"] as const;
export type RxTiming = (typeof RX_TIMINGS)[number];
export const RX_TIMING_LABELS: Record<RxTiming, { en: string; hi: string; mr: string }> = {
  BEFORE_FOOD: { en: "Before food", hi: "खाने से पहले", mr: "जेवणापूर्वी" },
  AFTER_FOOD: { en: "After food", hi: "खाने के बाद", mr: "जेवणानंतर" },
  WITH_FOOD: { en: "With food", hi: "खाने के साथ", mr: "जेवणासोबत" },
  EMPTY_STOMACH: { en: "On an empty stomach", hi: "खाली पेट", mr: "उपाशीपोटी" },
  BEDTIME: { en: "At bedtime", hi: "सोते समय", mr: "झोपताना" },
  AS_NEEDED: { en: "When needed", hi: "ज़रूरत होने पर", mr: "गरज असल्यास" },
  ANY_TIME: { en: "Any time", hi: "किसी भी समय", mr: "केव्हाही" },
};

/** Common frequency patterns (morning-afternoon-night). */
export const RX_FREQUENCIES = ["1-0-0", "0-1-0", "0-0-1", "1-0-1", "1-1-1", "1-1-1-1", "0-1-1", "1-1-0", "SOS", "ONCE_WEEKLY", "STAT"] as const;
export const RX_FREQUENCY_LABELS: Record<string, { en: string; hi: string; mr: string }> = {
  "1-0-0": { en: "Once a day (morning)", hi: "दिन में एक बार (सुबह)", mr: "दिवसातून एकदा (सकाळी)" },
  "0-1-0": { en: "Once a day (afternoon)", hi: "दिन में एक बार (दोपहर)", mr: "दिवसातून एकदा (दुपारी)" },
  "0-0-1": { en: "Once a day (night)", hi: "दिन में एक बार (रात)", mr: "दिवसातून एकदा (रात्री)" },
  "1-0-1": { en: "Twice a day (morning and night)", hi: "दिन में दो बार (सुबह और रात)", mr: "दिवसातून दोनदा (सकाळी आणि रात्री)" },
  "1-1-1": { en: "Three times a day", hi: "दिन में तीन बार", mr: "दिवसातून तीनदा" },
  "1-1-1-1": { en: "Four times a day", hi: "दिन में चार बार", mr: "दिवसातून चार वेळा" },
  "0-1-1": { en: "Twice a day (afternoon and night)", hi: "दिन में दो बार (दोपहर और रात)", mr: "दिवसातून दोनदा (दुपारी आणि रात्री)" },
  "1-1-0": { en: "Twice a day (morning and afternoon)", hi: "दिन में दो बार (सुबह और दोपहर)", mr: "दिवसातून दोनदा (सकाळी आणि दुपारी)" },
  SOS: { en: "Only when needed", hi: "केवल ज़रूरत पर", mr: "फक्त गरज असल्यास" },
  ONCE_WEEKLY: { en: "Once a week", hi: "सप्ताह में एक बार", mr: "आठवड्यातून एकदा" },
  STAT: { en: "Immediately, once", hi: "तुरंत, एक बार", mr: "लगेच, एकदा" },
};

/** Doses per day for a frequency pattern (null: cannot compute — the doctor enters the quantity). */
export function dosesPerDay(frequency: string): number | null {
  if (/^\d(-\d){2,3}$/.test(frequency)) return frequency.split("-").reduce((n, v) => n + Number(v), 0);
  if (frequency === "ONCE_WEEKLY") return 1 / 7;
  if (frequency === "STAT") return null;
  return null;
}

/** Units per dose from a dose text like "1 tablet", "1/2", "2 puffs", "5 ml" (ml / drops / applications count as 1 unit). */
export function unitsPerDose(dose: string): number {
  const m = dose.trim().match(/^(\d+(?:\.\d+)?|\d+\/\d+|½)/);
  if (!m) return 1;
  const v = m[1] === "½" ? 0.5 : m[1].includes("/") ? Number(m[1].split("/")[0]) / Number(m[1].split("/")[1]) : Number(m[1]);
  if (/ml|drop|apply|application|puff|unit|iu/i.test(dose) && !/tab|cap/i.test(dose)) return 1;
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** Automatic quantity: tablets / capsules = doses × days (rounded up); liquids, creams, inhalers = 1 pack. */
export function autoQuantity(input: { form: string; dose: string; frequency: string; durationDays: number }): number {
  const countable = input.form === "TABLET" || input.form === "CAPSULE" || input.form === "SACHET" || input.form === "SUPPOSITORY" || input.form === "PATCH";
  if (!countable) return 1;
  const perDay = dosesPerDay(input.frequency);
  if (perDay == null) return Math.max(1, Math.ceil(unitsPerDose(input.dose)));
  return Math.max(1, Math.ceil(perDay * unitsPerDose(input.dose) * Math.max(1, input.durationDays)));
}

export function bmiOf(weightKg?: number | null, heightCm?: number | null): number | null {
  if (!weightKg || !heightCm || heightCm < 30) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

export const SUGGESTION_TYPES = ["DOCTOR_REFERRAL", "CARE_STAFF", "EQUIPMENT", "LAB_TEST", "FOLLOW_UP"] as const;
export type SuggestionType = (typeof SUGGESTION_TYPES)[number];
export const SUGGESTION_TYPE_LABELS: Record<SuggestionType, string> = {
  DOCTOR_REFERRAL: "See a specialist",
  CARE_STAFF: "Home care",
  EQUIPMENT: "Medical equipment",
  LAB_TEST: "Lab tests",
  FOLLOW_UP: "Follow-up visit",
};
export const URGENCIES = ["ROUTINE", "SOON", "URGENT"] as const;
export type Urgency = (typeof URGENCIES)[number];

export const DOCUMENT_SOURCES = ["DOCTOR", "LAB", "PATIENT", "PROVIDER", "STORE", "SYSTEM"] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];
export const DOCUMENT_SOURCE_LABELS: Record<DocumentSource, string> = {
  DOCTOR: "Doctor",
  LAB: "Lab",
  PATIENT: "Patient uploaded",
  PROVIDER: "Care provider",
  STORE: "Medical store",
  SYSTEM: "GoKesari",
};
export const DOCUMENT_KINDS = ["LAB_REPORT", "SCAN", "DISCHARGE_SUMMARY", "PRESCRIPTION", "BILL", "VISIT_NOTE", "OTHER"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  LAB_REPORT: "Lab report",
  SCAN: "Scan / X-ray",
  DISCHARGE_SUMMARY: "Discharge summary",
  PRESCRIPTION: "Prescription (paper)",
  BILL: "Bill",
  VISIT_NOTE: "Visit note",
  OTHER: "Other",
};

export const TIMELINE_KINDS = ["APPOINTMENT", "CONSULTATION", "PRESCRIPTION", "DOCUMENT", "MEDICINE_ORDER", "CARE_VISIT", "EQUIPMENT", "REFERRAL", "SUGGESTION", "PROFILE"] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];
export const TIMELINE_KIND_LABELS: Record<TimelineKind, string> = {
  APPOINTMENT: "Appointment",
  CONSULTATION: "Consultation",
  PRESCRIPTION: "Prescription",
  DOCUMENT: "Report / document",
  MEDICINE_ORDER: "Medicine order",
  CARE_VISIT: "Home-care visit",
  EQUIPMENT: "Equipment",
  REFERRAL: "Referral",
  SUGGESTION: "Doctor's suggestion",
  PROFILE: "Health profile",
};

export const LETTERHEAD_MODES = ["DIGITAL", "PREPRINTED", "STANDARD"] as const;
export type LetterheadMode = (typeof LETTERHEAD_MODES)[number];
export const LETTERHEAD_MODE_LABELS: Record<LetterheadMode, string> = {
  DIGITAL: "My digital letterhead (upload header / footer images)",
  PREPRINTED: "My pre-printed letterhead paper (print text only, in the blank area)",
  STANDARD: "GoKesari standard letterhead (built from my profile)",
};
export const PAPER_SIZES = ["A4", "A5", "LETTER"] as const;
export type PaperSizeKey = (typeof PAPER_SIZES)[number];
export const LOCAL_LANGUAGES = ["NONE", "HI", "MR"] as const;
export type LocalLanguage = (typeof LOCAL_LANGUAGES)[number];
export const LOCAL_LANGUAGE_LABELS: Record<LocalLanguage, string> = { NONE: "English only", HI: "English + Hindi", MR: "English + Marathi" };

/** Sections a doctor can choose to print. */
export const RX_SECTIONS = ["vitals", "complaints", "history", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp", "suggestions", "signature", "qr"] as const;
export type RxSection = (typeof RX_SECTIONS)[number];
export const RX_SECTION_LABELS: Record<RxSection, string> = {
  vitals: "Vitals",
  complaints: "Chief complaints",
  history: "History",
  examination: "Examination findings",
  diagnosis: "Diagnosis",
  medicines: "Medicines",
  investigations: "Tests advised",
  advice: "Advice",
  followUp: "Follow-up date",
  suggestions: "Referrals and suggestions",
  signature: "Signature",
  qr: "Verification QR code",
};
export const DEFAULT_RX_SECTIONS: Record<RxSection, boolean> = {
  vitals: true,
  complaints: true,
  history: false,
  examination: false,
  diagnosis: true,
  medicines: true,
  investigations: true,
  advice: true,
  followUp: true,
  suggestions: true,
  signature: true,
  qr: true,
};

export const RX_ORDER_STATUSES = ["SENT", "QUOTED", "DECLINED", "EXPIRED", "CANCELLED", "APPROVED", "PAID", "PACKED", "READY_FOR_PICKUP", "OUT_FOR_DELIVERY", "COMPLETED"] as const;
export type RxOrderStatus = (typeof RX_ORDER_STATUSES)[number];
export const RX_ORDER_STATUS_LABELS: Record<RxOrderStatus, string> = {
  SENT: "Waiting for the store",
  QUOTED: "Quote ready — please approve",
  DECLINED: "Declined by the store",
  EXPIRED: "No reply in time",
  CANCELLED: "Cancelled",
  APPROVED: "Approved — being packed",
  PAID: "Paid — being packed",
  PACKED: "Packed",
  READY_FOR_PICKUP: "Ready for pickup",
  OUT_FOR_DELIVERY: "Out for delivery",
  COMPLETED: "Completed",
};
export const RX_FULFILMENTS = ["PICKUP", "DELIVERY"] as const;
export type RxFulfilment = (typeof RX_FULFILMENTS)[number];
export const RX_FULFILMENT_LABELS: Record<RxFulfilment, string> = { PICKUP: "I will collect it in person", DELIVERY: "Deliver to my address" };

export const CARE_VISIT_STATUSES = ["SCHEDULED", "ON_THE_WAY", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export type CareVisitStatus = (typeof CARE_VISIT_STATUSES)[number];
export const CARE_VISIT_STATUS_LABELS: Record<CareVisitStatus, string> = {
  SCHEDULED: "Scheduled",
  ON_THE_WAY: "On the way",
  IN_PROGRESS: "Visit in progress",
  COMPLETED: "Visit completed",
  CANCELLED: "Cancelled",
};
/** Consult category group that holds the home-care categories (0153). */
export const CARE_CATEGORY_GROUP = "Home care";
/** Home-care categories that live in another group (physiotherapists are in "Health — Therapy", 0161). */
export const EXTRA_CARE_CATEGORY_SLUGS = ["physiotherapist"] as const;

export const RENTAL_STATUSES = ["PENDING_PAYMENT", "CONFIRMED", "OUT_FOR_DELIVERY", "ACTIVE", "RETURN_SCHEDULED", "RETURNED", "CLOSED", "CANCELLED"] as const;
export type RentalStatus = (typeof RENTAL_STATUSES)[number];
export const RENTAL_STATUS_LABELS: Record<RentalStatus, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  CONFIRMED: "Booked",
  OUT_FOR_DELIVERY: "Out for delivery",
  ACTIVE: "In use",
  RETURN_SCHEDULED: "Return pickup scheduled",
  RETURNED: "Returned — condition check",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};
export const RENTAL_UNITS = ["DAY", "WEEK", "MONTH"] as const;
export type RentalUnit = (typeof RENTAL_UNITS)[number];

export const PRIME_TIERS = ["FREE", "PRIME", "PRIME_PLUS"] as const;
export type PrimeTier = (typeof PRIME_TIERS)[number];
export const PRIME_TIER_LABELS: Record<PrimeTier, string> = { FREE: "Free listing", PRIME: "Prime", PRIME_PLUS: "Prime Plus" };
export const PRIME_TERMS = ["MONTHLY", "QUARTERLY", "YEARLY"] as const;
export type PrimeTerm = (typeof PRIME_TERMS)[number];
export const PRIME_TERM_MONTHS: Record<PrimeTerm, number> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };
export const PRIME_AUDIENCES = ["DOCTOR", "CARE_PROVIDER", "EQUIPMENT_STORE"] as const;
export type PrimeAudience = (typeof PRIME_AUDIENCES)[number];
export const PRIME_FEATURE_LABELS: Record<string, string> = {
  instantBooking: "Instant online booking (real-time slots)",
  priorityPlacement: "Priority placement in search (labelled Prime)",
  badge: "Prime badge",
  virtualNumber: "Virtual phone number with call tracking",
  messaging: "WhatsApp / SMS booking notices and reminders",
  stories: "Patient stories and reviews management",
  analytics: "Profile analytics (views, calls, bookings, conversion)",
  onlinePayments: "Online payment collection and payout",
  multiClinic: "Several clinics and doctors",
  staffLogins: "Staff logins",
  featured: "Featured on the GoKesari Health home page",
  advancedAnalytics: "Advanced analytics",
  printHelper: "Auto-print helper licence",
};
/** Stated on every plan page (owner brief: Prime does not guarantee patients). */
export const PRIME_TERMS_NOTE =
  "Prime improves how your profile is shown (always labelled \"Prime\") and adds booking, calling and analytics tools. It does not guarantee any number of patients, calls or bookings. Free listings are never hidden. GST at 18% is added to the plan price.";

/** Launch mode (rule health.primeForAll), owner decision 20-Nov-2026. */
export const PRIME_LAUNCH_NOTE =
  "Launch offer: every Prime feature is included for every verified provider — instant online booking, analytics, booking notices and online payments. There is no plan to buy. You pay only GoKesari's standard registration fee (₹999 for turnover up to ₹2 crore, plus GST) and 2% on order value. Free listings are never hidden and no listing is ranked above another for payment.";

/** NMC Code of Ethics: shown wherever a doctor makes a referral or suggestion. */
export const NMC_ETHICS_NOTE =
  "GoKesari never pays or credits a doctor for a referral or suggestion (NMC Code of Ethics). You see only whether the patient booked — never prices or commissions.";
