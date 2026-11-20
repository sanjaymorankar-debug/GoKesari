/**
 * GoKesari Health (docs/health/): the tables in Postgres schema "health" (drizzle/0154_health.sql).
 *
 * Foreign keys to public tables (users, shops, consult_*) exist in the SQL; they are not
 * repeated here so this file needs no import from schema.ts (which re-exports it).
 */
import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, customType, date, doublePrecision, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; default: false }>({ dataType: () => "bytea" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const money = (name: string) => bigint(name, { mode: "number" });

export const health = pgSchema("health");

export const healthPatients = health.table("patients", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountUserId: uuid("account_user_id").notNull(),
  linkedUserId: uuid("linked_user_id"),
  relation: text("relation").notNull().default("SELF"),
  fullName: text("full_name").notNull(),
  dateOfBirth: date("date_of_birth", { mode: "string" }),
  gender: text("gender"),
  bloodGroup: text("blood_group"),
  allergies: text("allergies").array().notNull().default(sql`'{}'::text[]`),
  conditions: text("conditions").array().notNull().default(sql`'{}'::text[]`),
  currentMedicines: text("current_medicines"),
  emergencyName: text("emergency_name"),
  emergencyPhone: text("emergency_phone"),
  emergencyRelation: text("emergency_relation"),
  phone: text("phone"),
  email: text("email"),
  abhaNumber: text("abha_number"),
  abhaAddress: text("abha_address"),
  recordStartAt: ts("record_start_at").notNull().defaultNow(),
  linkStatus: text("link_status").notNull().default("ACTIVE"),
  linkCodeHash: text("link_code_hash"),
  linkCodeExpiresAt: ts("link_code_expires_at"),
  linkCodeAttempts: integer("link_code_attempts").notNull().default(0),
  hiddenAt: ts("hidden_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthPatient = typeof healthPatients.$inferSelect;

export const healthConsents = health.table("consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  patientId: uuid("patient_id").notNull(),
  kind: text("kind").notNull(),
  mode: text("mode").notNull().default("ALWAYS"),
  granteeMemberId: uuid("grantee_member_id"),
  granteeShopId: uuid("grantee_shop_id"),
  bookingId: uuid("booking_id"),
  version: text("version").notNull(),
  textSnapshot: text("text_snapshot").notNull(),
  grantedBy: uuid("granted_by").notNull(),
  grantedAt: ts("granted_at").notNull().defaultNow(),
  revokedAt: ts("revoked_at"),
  revokedBy: uuid("revoked_by"),
});
export type HealthConsent = typeof healthConsents.$inferSelect;

export const healthAccessLog = health.table("access_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  patientId: uuid("patient_id").notNull(),
  actorUserId: uuid("actor_user_id"),
  actorRole: text("actor_role").notNull(),
  actorLabel: text("actor_label").notNull(),
  action: text("action").notNull(),
  objectType: text("object_type").notNull(),
  objectId: uuid("object_id"),
  reason: text("reason"),
  ipAddress: text("ip_address"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type HealthAccessLogRow = typeof healthAccessLog.$inferSelect;

export const healthDoctorProfiles = health.table("doctor_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id").notNull(),
  shopId: uuid("shop_id").notNull(),
  userId: uuid("user_id"),
  practitionerType: text("practitioner_type").notNull().default("DOCTOR"),
  fullName: text("full_name").notNull(),
  qualifications: text("qualifications").notNull(),
  specialties: text("specialties").array().notNull().default(sql`'{}'::text[]`),
  council: text("council").notNull(),
  registrationNumber: text("registration_number").notNull(),
  registrationYear: integer("registration_year"),
  hprId: text("hpr_id"),
  signatureImage: bytea("signature_image"),
  signatureType: text("signature_type"),
  stampImage: bytea("stamp_image"),
  stampType: text("stamp_type"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthDoctorProfile = typeof healthDoctorProfiles.$inferSelect;

export const healthCareProviderProfiles = health.table("care_provider_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id").notNull(),
  shopId: uuid("shop_id").notNull(),
  userId: uuid("user_id"),
  providerKind: text("provider_kind").notNull().default("INDIVIDUAL"),
  gender: text("gender"),
  careCategories: text("care_categories").array().notNull().default(sql`'{}'::text[]`),
  registrationBody: text("registration_body"),
  registrationNumber: text("registration_number"),
  policeVerification: text("police_verification").notNull().default("NOT_REQUIRED"),
  servicePincodes: text("service_pincodes").array().notNull().default(sql`'{}'::text[]`),
  serviceRadiusKm: integer("service_radius_km").notNull().default(10),
  idCardNumber: text("id_card_number").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthCareProviderProfile = typeof healthCareProviderProfiles.$inferSelect;

export const healthPharmacyProfiles = health.table("pharmacy_profiles", {
  shopId: uuid("shop_id").primaryKey(),
  drugLicenceNumber: text("drug_licence_number").notNull(),
  pharmacistName: text("pharmacist_name").notNull(),
  pharmacistRegistrationNumber: text("pharmacist_registration_number").notNull(),
  pharmacyCouncil: text("pharmacy_council"),
  acceptsPrescriptions: boolean("accepts_prescriptions").notNull().default(true),
  ownDelivery: boolean("own_delivery").notNull().default(true),
  cashOnHandover: boolean("cash_on_handover").notNull().default(true),
  deliveryRadiusKm: integer("delivery_radius_km").notNull().default(5),
  verification: text("verification").notNull().default("PENDING"),
  verificationNote: text("verification_note"),
  verifiedBy: uuid("verified_by"),
  verifiedAt: ts("verified_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthPharmacyProfile = typeof healthPharmacyProfiles.$inferSelect;

export const healthEquipmentStoreProfiles = health.table("equipment_store_profiles", {
  shopId: uuid("shop_id").primaryKey(),
  rentalTerms: text("rental_terms"),
  damagePolicy: text("damage_policy"),
  deliveryRadiusKm: integer("delivery_radius_km").notNull().default(10),
  verification: text("verification").notNull().default("PENDING"),
  verificationNote: text("verification_note"),
  verifiedBy: uuid("verified_by"),
  verifiedAt: ts("verified_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthEquipmentStoreProfile = typeof healthEquipmentStoreProfiles.$inferSelect;

export const healthClinicSettings = health.table("clinic_settings", {
  shopId: uuid("shop_id").primaryKey(),
  tokenMode: boolean("token_mode").notNull().default(false),
  tokenDailyLimit: integer("token_daily_limit").notNull().default(40),
  followUpDays: integer("follow_up_days").notNull().default(7),
  followUpFeePaise: money("follow_up_fee_paise"),
  hfrId: text("hfr_id"),
  payPerBooking: boolean("pay_per_booking").notNull().default(false),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthClinicSettings = typeof healthClinicSettings.$inferSelect;

export const healthLetterheads = health.table("letterheads", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id").notNull(),
  memberId: uuid("member_id"),
  mode: text("mode").notNull().default("STANDARD"),
  paper: text("paper").notNull().default("A4"),
  marginTopMm: numeric("margin_top_mm", { mode: "number" }).notNull().default(15),
  marginBottomMm: numeric("margin_bottom_mm", { mode: "number" }).notNull().default(15),
  marginLeftMm: numeric("margin_left_mm", { mode: "number" }).notNull().default(15),
  marginRightMm: numeric("margin_right_mm", { mode: "number" }).notNull().default(15),
  headerHeightMm: numeric("header_height_mm", { mode: "number" }).notNull().default(35),
  footerHeightMm: numeric("footer_height_mm", { mode: "number" }).notNull().default(15),
  headerImage: bytea("header_image"),
  headerType: text("header_type"),
  footerImage: bytea("footer_image"),
  footerType: text("footer_type"),
  backgroundImage: bytea("background_image"),
  backgroundType: text("background_type"),
  fontSizePt: integer("font_size_pt").notNull().default(10),
  sections: jsonb("sections").$type<Record<string, boolean>>().notNull().default({}),
  localLanguage: text("local_language").notNull().default("NONE"),
  showSignature: boolean("show_signature").notNull().default(true),
  autoPrint: boolean("auto_print").notNull().default(false),
  printerName: text("printer_name"),
  updatedBy: uuid("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthLetterhead = typeof healthLetterheads.$inferSelect;

export const healthDrugMaster = health.table("drug_master", {
  id: uuid("id").primaryKey().defaultRandom(),
  genericName: text("generic_name").notNull(),
  brandName: text("brand_name"),
  strength: text("strength"),
  form: text("form").notNull().default("TABLET"),
  manufacturer: text("manufacturer"),
  schedule: text("schedule").notNull().default("H"),
  rxRequired: boolean("rx_required").notNull().default(true),
  teleList: text("tele_list").notNull().default("A"),
  onlineSaleAllowed: boolean("online_sale_allowed").notNull().default(true),
  status: text("status").notNull().default("ACTIVE"),
  updatedBy: uuid("updated_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthDrug = typeof healthDrugMaster.$inferSelect;

export const healthIcd10 = health.table("icd10_codes", {
  code: text("code").primaryKey(),
  title: text("title").notNull(),
  chapter: text("chapter"),
});

export const healthAppointmentLinks = health.table("appointment_links", {
  bookingId: uuid("booking_id").primaryKey(),
  patientId: uuid("patient_id").notNull(),
  shareRecords: text("share_records").notNull().default("OFF"),
  visitType: text("visit_type").notNull().default("NEW"),
  reason: text("reason"),
  tokenNumber: integer("token_number"),
  queueOrder: integer("queue_order"),
  calledAt: ts("called_at"),
  referralSuggestionId: uuid("referral_suggestion_id"),
  sourceSuggestionId: uuid("source_suggestion_id"),
  walkIn: boolean("walk_in").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type HealthAppointmentLink = typeof healthAppointmentLinks.$inferSelect;

export interface Vitals {
  bpSystolic?: number | null;
  bpDiastolic?: number | null;
  pulse?: number | null;
  temperatureC?: number | null;
  spo2?: number | null;
  weightKg?: number | null;
  heightCm?: number | null;
  bmi?: number | null;
  respiratoryRate?: number | null;
  bloodSugar?: number | null;
}
export interface Diagnosis {
  code?: string | null;
  text: string;
}
export interface Investigation {
  name: string;
  note?: string | null;
  homeCollection?: boolean;
}

export const healthConsultations = health.table("consultations", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingId: uuid("booking_id"),
  shopId: uuid("shop_id").notNull(),
  memberId: uuid("member_id").notNull(),
  doctorUserId: uuid("doctor_user_id"),
  patientId: uuid("patient_id").notNull(),
  mode: text("mode").notNull().default("IN_PERSON"),
  visitType: text("visit_type").notNull().default("NEW"),
  status: text("status").notNull().default("IN_PROGRESS"),
  vitals: jsonb("vitals").$type<Vitals>().notNull().default({}),
  chiefComplaints: text("chief_complaints"),
  history: text("history"),
  examination: text("examination"),
  diagnoses: jsonb("diagnoses").$type<Diagnosis[]>().notNull().default([]),
  investigations: jsonb("investigations").$type<Investigation[]>().notNull().default([]),
  advice: text("advice"),
  followUpDate: date("follow_up_date", { mode: "string" }),
  startedAt: ts("started_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthConsultation = typeof healthConsultations.$inferSelect;

export const healthPrescriptions = health.table("prescriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull(),
  patientId: uuid("patient_id").notNull(),
  shopId: uuid("shop_id").notNull(),
  memberId: uuid("member_id").notNull(),
  doctorUserId: uuid("doctor_user_id"),
  rxNumber: text("rx_number").notNull(),
  version: integer("version").notNull().default(1),
  rootId: uuid("root_id"),
  supersedesId: uuid("supersedes_id"),
  amendReason: text("amend_reason"),
  status: text("status").notNull().default("ISSUED"),
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  pdf: bytea("pdf"),
  pdfHash: text("pdf_hash"),
  verificationToken: text("verification_token").notNull(),
  issuedAt: ts("issued_at").notNull().defaultNow(),
  validUntil: date("valid_until", { mode: "string" }),
  emailedAt: ts("emailed_at"),
  printCount: integer("print_count").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type HealthPrescription = typeof healthPrescriptions.$inferSelect;

export const healthPrescriptionItems = health.table("prescription_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  prescriptionId: uuid("prescription_id").notNull(),
  lineNo: integer("line_no").notNull(),
  drugId: uuid("drug_id"),
  genericName: text("generic_name").notNull(),
  brandName: text("brand_name"),
  strength: text("strength"),
  form: text("form").notNull().default("TABLET"),
  dose: text("dose").notNull(),
  frequency: text("frequency").notNull(),
  timing: text("timing").notNull().default("AFTER_FOOD"),
  durationDays: integer("duration_days").notNull(),
  quantity: integer("quantity").notNull(),
  instructions: text("instructions"),
  instructionsLocal: text("instructions_local"),
  teleList: text("tele_list"),
  rxRequired: boolean("rx_required").notNull().default(true),
  dispensedQty: integer("dispensed_qty").notNull().default(0),
});
export type HealthPrescriptionItem = typeof healthPrescriptionItems.$inferSelect;

export const healthSuggestions = health.table("suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull(),
  prescriptionId: uuid("prescription_id"),
  patientId: uuid("patient_id").notNull(),
  memberId: uuid("member_id").notNull(),
  type: text("type").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  targetMemberId: uuid("target_member_id"),
  targetShopId: uuid("target_shop_id"),
  urgency: text("urgency").notNull().default("ROUTINE"),
  printOnRx: boolean("print_on_rx").notNull().default(true),
  shareRecords: boolean("share_records").notNull().default(false),
  status: text("status").notNull().default("OPEN"),
  linkedBookingId: uuid("linked_booking_id"),
  linkedRxOrderId: uuid("linked_rx_order_id"),
  linkedRentalId: uuid("linked_rental_id"),
  bookedAt: ts("booked_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type HealthSuggestion = typeof healthSuggestions.$inferSelect;

export const healthDocuments = health.table("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  patientId: uuid("patient_id").notNull(),
  uploadedBy: uuid("uploaded_by"),
  source: text("source").notNull(),
  kind: text("kind").notNull().default("OTHER"),
  title: text("title").notNull(),
  documentDate: date("document_date", { mode: "string" }),
  consultationId: uuid("consultation_id"),
  prescriptionId: uuid("prescription_id"),
  careVisitId: uuid("care_visit_id"),
  providerMemberId: uuid("provider_member_id"),
  providerName: text("provider_name"),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  data: bytea("data").notNull(),
  hiddenAt: ts("hidden_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type HealthDocument = typeof healthDocuments.$inferSelect;

export const healthTimeline = health.table("timeline", {
  id: uuid("id").primaryKey().defaultRandom(),
  patientId: uuid("patient_id").notNull(),
  occurredAt: ts("occurred_at").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  providerName: text("provider_name"),
  providerMemberId: uuid("provider_member_id"),
  providerShopId: uuid("provider_shop_id"),
  refType: text("ref_type").notNull(),
  refId: uuid("ref_id").notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  hiddenAt: ts("hidden_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type HealthTimelineRow = typeof healthTimeline.$inferSelect;

export const healthEvents = health.table("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  userIds: uuid("user_ids").array().notNull().default(sql`'{}'::uuid[]`),
  shopId: uuid("shop_id"),
  subjectId: uuid("subject_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type HealthEventRow = typeof healthEvents.$inferSelect;

export const healthShareLinks = health.table("share_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull(),
  patientId: uuid("patient_id").notNull(),
  objectType: text("object_type").notNull(),
  objectId: uuid("object_id").notNull(),
  createdBy: uuid("created_by").notNull(),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  openCount: integer("open_count").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const healthRxTemplates = health.table("rx_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id").notNull(),
  kind: text("kind").notNull().default("TEMPLATE"),
  name: text("name").notNull(),
  content: jsonb("content").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthRxTemplate = typeof healthRxTemplates.$inferSelect;

export const healthRxOrders = health.table("rx_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderNumber: text("order_number").notNull(),
  prescriptionId: uuid("prescription_id").notNull(),
  patientId: uuid("patient_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  shopId: uuid("shop_id").notNull(),
  suggestionId: uuid("suggestion_id"),
  fulfilment: text("fulfilment").notNull(),
  pickupAt: ts("pickup_at"),
  address: jsonb("address").$type<Record<string, unknown> | null>(),
  distanceKm: numeric("distance_km", { mode: "number" }),
  status: text("status").notNull().default("SENT"),
  expiresAt: ts("expires_at").notNull(),
  quotedAt: ts("quoted_at"),
  decidedAt: ts("decided_at"),
  declineReason: text("decline_reason"),
  goodsPaise: money("goods_paise").notNull().default(0),
  discountPaise: money("discount_paise").notNull().default(0),
  deliveryPaise: money("delivery_paise").notNull().default(0),
  totalPaise: money("total_paise").notNull().default(0),
  paymentMode: text("payment_mode"),
  paymentStatus: text("payment_status").notNull().default("NOT_DUE"),
  paymentIntentId: uuid("payment_intent_id"),
  paidOnlinePaise: money("paid_online_paise").notNull().default(0),
  paidOfflinePaise: money("paid_offline_paise").notNull().default(0),
  refundPaise: money("refund_paise").notNull().default(0),
  commissionBp: integer("commission_bp").notNull().default(200),
  commissionPaise: money("commission_paise").notNull().default(0),
  settledAt: ts("settled_at"),
  otpSalt: text("otp_salt"),
  otpAttempts: integer("otp_attempts").notNull().default(0),
  deliveryPerson: text("delivery_person"),
  deliveryPhone: text("delivery_phone"),
  billNumber: text("bill_number"),
  packedAt: ts("packed_at"),
  readyAt: ts("ready_at"),
  dispatchedAt: ts("dispatched_at"),
  completedAt: ts("completed_at"),
  cancelledAt: ts("cancelled_at"),
  cancelReason: text("cancel_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthRxOrder = typeof healthRxOrders.$inferSelect;

export const healthRxOrderItems = health.table("rx_order_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  rxOrderId: uuid("rx_order_id").notNull(),
  prescriptionItemId: uuid("prescription_item_id").notNull(),
  requestedQty: integer("requested_qty").notNull(),
  availability: text("availability"),
  quotedQty: integer("quoted_qty").notNull().default(0),
  substituteName: text("substitute_name"),
  substituteGeneric: text("substitute_generic"),
  substituteStrength: text("substitute_strength"),
  substituteApproved: boolean("substitute_approved"),
  unitPricePaise: money("unit_price_paise").notNull().default(0),
  discountPaise: money("discount_paise").notNull().default(0),
  lineTotalPaise: money("line_total_paise").notNull().default(0),
  batchNumber: text("batch_number"),
  expiryDate: date("expiry_date", { mode: "string" }),
  dispensedQty: integer("dispensed_qty").notNull().default(0),
});
export type HealthRxOrderItem = typeof healthRxOrderItems.$inferSelect;

export const healthCareVisits = health.table("care_visits", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingId: uuid("booking_id").notNull(),
  patientId: uuid("patient_id").notNull(),
  shopId: uuid("shop_id").notNull(),
  memberId: uuid("member_id"),
  packageId: uuid("package_id"),
  sessionNo: integer("session_no"),
  status: text("status").notNull().default("SCHEDULED"),
  onTheWayAt: ts("on_the_way_at"),
  checkedInAt: ts("checked_in_at"),
  checkedOutAt: ts("checked_out_at"),
  otpSalt: text("otp_salt").notNull(),
  otpAttempts: integer("otp_attempts").notNull().default(0),
  lastLatitude: doublePrecision("last_latitude"),
  lastLongitude: doublePrecision("last_longitude"),
  lastLocationAt: ts("last_location_at"),
  notes: text("notes"),
  vitals: jsonb("vitals").$type<Vitals>().notNull().default({}),
  shareRecords: boolean("share_records").notNull().default(false),
  sosAt: ts("sos_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthCareVisit = typeof healthCareVisits.$inferSelect;

export const healthCarePackages = health.table("care_packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  patientId: uuid("patient_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  shopId: uuid("shop_id").notNull(),
  serviceId: uuid("service_id"),
  name: text("name").notNull(),
  sessionsTotal: integer("sessions_total").notNull(),
  sessionsDone: integer("sessions_done").notNull().default(0),
  status: text("status").notNull().default("ACTIVE"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthCarePackage = typeof healthCarePackages.$inferSelect;

export const healthEquipmentMaster = health.table("equipment_master", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  category: text("category").notNull().default("Mobility"),
  description: text("description"),
  rxRequired: boolean("rx_required").notNull().default(false),
  status: text("status").notNull().default("ACTIVE"),
  sortOrder: integer("sort_order").notNull().default(100),
});
export type HealthEquipmentMaster = typeof healthEquipmentMaster.$inferSelect;

export const healthEquipmentListings = health.table("equipment_listings", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id").notNull(),
  masterId: uuid("master_id"),
  name: text("name").notNull(),
  description: text("description"),
  photoUrl: text("photo_url"),
  forSale: boolean("for_sale").notNull().default(false),
  salePricePaise: money("sale_price_paise"),
  shopProductId: uuid("shop_product_id"),
  forRent: boolean("for_rent").notNull().default(true),
  rentDayPaise: money("rent_day_paise"),
  rentWeekPaise: money("rent_week_paise"),
  rentMonthPaise: money("rent_month_paise"),
  minRentDays: integer("min_rent_days").notNull().default(1),
  depositPaise: money("deposit_paise").notNull().default(0),
  deliveryPaise: money("delivery_paise").notNull().default(0),
  stock: integer("stock").notNull().default(1),
  rxRequired: boolean("rx_required").notNull().default(false),
  status: text("status").notNull().default("ACTIVE"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthEquipmentListing = typeof healthEquipmentListings.$inferSelect;

export interface RentalExtension {
  at: string;
  periodCount: number;
  rentPaise: number;
  newDueDate: string;
  paymentIntentId?: string | null;
}

export const healthRentals = health.table("rentals", {
  id: uuid("id").primaryKey().defaultRandom(),
  rentalNumber: text("rental_number").notNull(),
  listingId: uuid("listing_id").notNull(),
  shopId: uuid("shop_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  patientId: uuid("patient_id"),
  suggestionId: uuid("suggestion_id"),
  prescriptionId: uuid("prescription_id"),
  itemName: text("item_name").notNull(),
  quantity: integer("quantity").notNull().default(1),
  periodUnit: text("period_unit").notNull(),
  periodCount: integer("period_count").notNull(),
  startDate: date("start_date", { mode: "string" }).notNull(),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  rentPaise: money("rent_paise").notNull(),
  depositPaise: money("deposit_paise").notNull().default(0),
  deliveryPaise: money("delivery_paise").notNull().default(0),
  totalPaise: money("total_paise").notNull(),
  status: text("status").notNull().default("PENDING_PAYMENT"),
  paymentIntentId: uuid("payment_intent_id"),
  paidPaise: money("paid_paise").notNull().default(0),
  address: jsonb("address").$type<Record<string, unknown> | null>(),
  otpSalt: text("otp_salt").notNull(),
  otpAttempts: integer("otp_attempts").notNull().default(0),
  deliveredAt: ts("delivered_at"),
  returnPickupAt: ts("return_pickup_at"),
  returnedAt: ts("returned_at"),
  conditionNote: text("condition_note"),
  damagePaise: money("damage_paise").notNull().default(0),
  depositRefundPaise: money("deposit_refund_paise").notNull().default(0),
  depositRefundedAt: ts("deposit_refunded_at"),
  extensions: jsonb("extensions").$type<RentalExtension[]>().notNull().default([]),
  commissionBp: integer("commission_bp").notNull().default(200),
  settledAt: ts("settled_at"),
  closedAt: ts("closed_at"),
  cancelledAt: ts("cancelled_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthRental = typeof healthRentals.$inferSelect;

export interface PrimePrices {
  MONTHLY?: number;
  QUARTERLY?: number;
  YEARLY?: number;
}

export const healthPrimePlans = health.table("prime_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  audience: text("audience").notNull().default("DOCTOR"),
  tier: text("tier").notNull(),
  description: text("description"),
  features: jsonb("features").$type<Record<string, boolean>>().notNull().default({}),
  quotas: jsonb("quotas").$type<Record<string, number>>().notNull().default({}),
  prices: jsonb("prices").$type<PrimePrices>().notNull().default({}),
  city: text("city"),
  specialty: text("specialty"),
  status: text("status").notNull().default("ACTIVE"),
  sortOrder: integer("sort_order").notNull().default(100),
  updatedBy: uuid("updated_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthPrimePlan = typeof healthPrimePlans.$inferSelect;

export const healthPrimeSubscriptions = health.table("prime_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id").notNull(),
  planId: uuid("plan_id").notNull(),
  tier: text("tier").notNull(),
  term: text("term").notNull(),
  status: text("status").notNull().default("PENDING_PAYMENT"),
  startsAt: ts("starts_at"),
  endsAt: ts("ends_at"),
  graceUntil: ts("grace_until"),
  pricePaise: money("price_paise").notNull(),
  discountPaise: money("discount_paise").notNull().default(0),
  gstPaise: money("gst_paise").notNull(),
  totalPaise: money("total_paise").notNull(),
  couponCode: text("coupon_code"),
  paymentIntentId: uuid("payment_intent_id"),
  invoiceNumber: text("invoice_number"),
  autoRenewReminders: boolean("auto_renew_reminders").notNull().default(true),
  boughtBy: uuid("bought_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type HealthPrimeSubscription = typeof healthPrimeSubscriptions.$inferSelect;

export const healthPrimeCoupons = health.table("prime_coupons", {
  code: text("code").primaryKey(),
  percentOff: integer("percent_off").notNull(),
  maxUses: integer("max_uses"),
  used: integer("used").notNull().default(0),
  validUntil: ts("valid_until"),
  status: text("status").notNull().default("ACTIVE"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type HealthPrimeCoupon = typeof healthPrimeCoupons.$inferSelect;

export const healthVirtualNumbers = health.table("virtual_numbers", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id").notNull(),
  number: text("number").notNull(),
  forwardTo: text("forward_to").notNull(),
  provider: text("provider").notNull(),
  providerRef: text("provider_ref"),
  status: text("status").notNull().default("ACTIVE"),
  assignedAt: ts("assigned_at").notNull().defaultNow(),
  releasedAt: ts("released_at"),
});
export type HealthVirtualNumber = typeof healthVirtualNumbers.$inferSelect;

export const healthCallLogs = health.table("call_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  virtualNumberId: uuid("virtual_number_id").notNull(),
  shopId: uuid("shop_id").notNull(),
  providerCallId: text("provider_call_id").notNull(),
  callerMasked: text("caller_masked").notNull(),
  startedAt: ts("started_at").notNull(),
  durationSeconds: integer("duration_seconds").notNull().default(0),
  status: text("status").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type HealthCallLog = typeof healthCallLogs.$inferSelect;

export const healthProfileStats = health.table(
  "profile_stats",
  {
    shopId: uuid("shop_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    views: integer("views").notNull().default(0),
    calls: integer("calls").notNull().default(0),
    missedCalls: integer("missed_calls").notNull().default(0),
    bookings: integer("bookings").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.day] })],
);

export const healthDataRequests = health.table("data_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("OPEN"),
  note: text("note"),
  createdAt: ts("created_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
});
export type HealthDataRequest = typeof healthDataRequests.$inferSelect;

export const healthCounters = health.table("counters", {
  series: text("series").primaryKey(),
  nextNo: integer("next_no").notNull().default(1),
});
