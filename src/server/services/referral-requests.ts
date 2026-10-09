/**
 * Shop referral codes: the mandatory code on self-service registration, and
 * "Request a referral code" for owners without one (docs/four-features-2026-10, feature 4).
 *
 * A request is saved, operations are told in the app, and the referrals team
 * gets an email (rule shopReferral.notifyEmails, default referrals@gokesari.com)
 * with name, mobile, type of shop, area, city, PIN code, coordinates, the
 * Google Maps link and the time. One request per mobile number per
 * duplicateWindowHours. Operations then issue a code (an ordinary referral
 * code, the same as one made on the admin screen) or reject the request.
 */
import crypto from "node:crypto";

import { and, desc, eq, gte, sql } from "drizzle-orm";

import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { maskPhone } from "@/lib/phone";
import { checkReferralRequest, referralRequestReference, type ReferralRequestInput } from "@/lib/referral-requests";
import { shopTypeLabel } from "@/lib/shop-types";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { referralCodeRequests, referralCodes, type ReferralCodeRequest, type ReferralRequestStatus, type UserRole } from "@/server/db/schema";
import { sendEmail, emailMode } from "@/server/email/transport";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { attributeShopToCode, createReferralCode, resolveCodeForShop } from "./referrals";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

/* ===================================================== registration */

/**
 * Self-service shop registration with rule shopReferral.required: the code
 * must exist, be active and unexpired. Returns the normalised code; throws a
 * field error otherwise. Privileged (operator) registrations are not checked.
 */
export async function assertRegistrationReferralCode(raw: string | null | undefined): Promise<string | null> {
  const rule = await getRule("shopReferral");
  if (!rule.required) return null;
  const code = (raw ?? "").trim();
  if (!code) {
    throw validationFailed("Enter your referral code, or request one.", { fields: { referralCode: "A referral code is required to register a shop." } });
  }
  try {
    return (await resolveCodeForShop(code)).code;
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
      throw validationFailed(`${error.message} Check the code, or request one.`, { fields: { referralCode: error.message } });
    }
    throw error;
  }
}

/** For the form's on-blur check: valid or not, nothing more. */
export async function checkReferralCode(raw: string): Promise<{ valid: boolean; message: string | null }> {
  try {
    await resolveCodeForShop(raw);
    return { valid: true, message: null };
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") return { valid: false, message: error.message };
    throw error;
  }
}

/* ========================================================== requests */

export interface ReferralRequestView {
  id: string;
  reference: string;
  name: string;
  mobile: string;
  shopType: string;
  shopTypeLabel: string;
  area: string;
  city: string;
  pincode: string;
  latitude: string | null;
  longitude: string | null;
  mapsUrl: string | null;
  locationStatus: "SHARED" | "NOT_SHARED";
  status: ReferralRequestStatus;
  issuedCode: string | null;
  decisionNote: string | null;
  emailStatus: string | null;
  emailError: string | null;
  createdAt: string;
  decidedAt: string | null;
}

function toView(row: ReferralCodeRequest): ReferralRequestView {
  return {
    id: row.id,
    reference: referralRequestReference(row.id),
    name: row.name,
    mobile: row.mobileE164,
    shopType: row.shopType,
    shopTypeLabel: shopTypeLabel(row.shopType),
    area: row.area,
    city: row.city,
    pincode: row.pincode,
    latitude: row.latitude,
    longitude: row.longitude,
    mapsUrl: row.mapsUrl,
    locationStatus: row.locationStatus,
    status: row.status,
    issuedCode: row.issuedCode,
    decisionNote: row.decisionNote,
    emailStatus: row.emailStatus,
    emailError: row.emailError,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

const istTime = (at: Date) =>
  at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST";

function emailFor(row: ReferralCodeRequest): { subject: string; text: string; html: string } {
  const reference = referralRequestReference(row.id);
  const coordinates = row.latitude && row.longitude ? `${row.latitude}, ${row.longitude}${row.locationAccuracyM ? ` (±${row.locationAccuracyM} m)` : ""}` : "Not shared";
  const lines: [string, string][] = [
    ["Reference", reference],
    ["Name", row.name],
    ["Mobile", row.mobileE164],
    ["Type of shop", shopTypeLabel(row.shopType)],
    ["Area", row.area],
    ["City", row.city],
    ["PIN code", row.pincode],
    ["Location", row.locationStatus === "SHARED" ? "Shared from the browser" : "Not shared (permission denied or unavailable)"],
    ["Coordinates", coordinates],
    ["Google Maps", row.mapsUrl ?? "—"],
    ["Requested at", istTime(row.createdAt)],
  ];
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    subject: `Referral code request ${reference} — ${row.name}, ${row.city} ${row.pincode}`,
    text: `A shop owner has asked for a GoKesari referral code.\n\n${lines.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nIssue a code or reject the request in Admin → Referral requests.`,
    html:
      `<p>A shop owner has asked for a GoKesari referral code.</p><table cellpadding="4">` +
      lines
        .map(([k, v]) => `<tr><td><b>${escape(k)}</b></td><td>${v.startsWith("https://") ? `<a href="${escape(v)}">${escape(v)}</a>` : escape(v)}</td></tr>`)
        .join("") +
      `</table><p>Issue a code or reject the request in Admin → Referral requests.</p>`,
  };
}

/** Sends (or re-sends) the referrals email and records how it went. Never throws. */
async function emailReferralsTeam(row: ReferralCodeRequest): Promise<ReferralCodeRequest> {
  const rule = await getRule("shopReferral");
  let status: "SENT" | "FAILED" | "NOT_CONFIGURED" = "SENT";
  let error: string | null = null;
  if (emailMode() === "disabled") {
    status = "NOT_CONFIGURED";
    error = "Email is not configured on this site (AUTH_EMAIL_FROM / AUTH_EMAIL_SERVER).";
  } else {
    const message = emailFor(row);
    for (const to of rule.notifyEmails) {
      try {
        await sendEmail({ to, ...message });
      } catch (caught) {
        status = "FAILED";
        error = `${to}: ${caught instanceof Error ? caught.message : String(caught)}`.slice(0, 500);
      }
    }
  }
  const [updated] = await db
    .update(referralCodeRequests)
    .set({ emailStatus: status, emailError: error, emailSentAt: status === "SENT" ? new Date() : row.emailSentAt, updatedAt: new Date() })
    .where(eq(referralCodeRequests.id, row.id))
    .returning();
  if (status !== "SENT") console.error("[referral-requests] email not sent", referralRequestReference(row.id), status, error);
  return updated;
}

export async function createReferralRequest(
  input: ReferralRequestInput,
  context: { userId: string | null },
): Promise<{ reference: string; createdAt: string; mobileMasked: string; locationShared: boolean }> {
  const checked = checkReferralRequest(input);
  if (!checked.ok) throw validationFailed(Object.values(checked.fields)[0], { fields: checked.fields });
  const request = checked.value;
  const rule = await getRule("shopReferral");

  const row = await db.transaction(async (tx) => {
    // One at a time per mobile number, so two quick taps make one request.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`referral-request:${request.mobileE164}`}))`);
    const since = new Date(Date.now() - rule.duplicateWindowHours * 3_600_000);
    const [recent] = await tx
      .select()
      .from(referralCodeRequests)
      .where(and(eq(referralCodeRequests.mobileE164, request.mobileE164), gte(referralCodeRequests.createdAt, since)))
      .orderBy(desc(referralCodeRequests.createdAt))
      .limit(1);
    if (recent) {
      throw new AppError(
        "RATE_LIMITED",
        `We already have a request from this mobile number (${referralRequestReference(recent.id)}, ${istTime(recent.createdAt)}). Our team will contact you — there is no need to ask again.`,
        { reference: referralRequestReference(recent.id) },
      );
    }
    const [created] = await tx
      .insert(referralCodeRequests)
      .values({
        userId: context.userId,
        name: request.name,
        mobileE164: request.mobileE164,
        shopType: request.shopType,
        area: request.area,
        city: request.city,
        pincode: request.pincode,
        latitude: request.location ? String(request.location.latitude) : null,
        longitude: request.location ? String(request.location.longitude) : null,
        locationAccuracyM: request.location?.accuracyM ?? null,
        mapsUrl: request.location?.mapsUrl ?? null,
        locationStatus: request.location ? "SHARED" : "NOT_SHARED",
      })
      .returning();
    await recordAudit(
      {
        actorId: context.userId,
        action: AUDIT_ACTIONS.REFERRAL_REQUEST_CREATED,
        entityType: "referral_code_request",
        entityId: created.id,
        newValue: { mobile: maskPhone(created.mobileE164), city: created.city, pincode: created.pincode, locationStatus: created.locationStatus },
      },
      tx,
    );
    await emitEvent(
      {
        type: "referral_request.created",
        subjectId: created.id,
        actor: context.userId ? { id: context.userId, role: null } : null,
        payload: {
          requestId: created.id,
          name: created.name,
          city: created.city,
          pincode: created.pincode,
          shopTypeLabel: shopTypeLabel(created.shopType),
        },
      },
      tx,
    );
    return created;
  });

  await emailReferralsTeam(row);
  return {
    reference: referralRequestReference(row.id),
    createdAt: row.createdAt.toISOString(),
    mobileMasked: maskPhone(row.mobileE164),
    locationShared: row.locationStatus === "SHARED",
  };
}

/* =========================================================== operations */

function assertManager(actor: Actor) {
  if (!can(actor.role, PERMISSIONS.REFERRAL_MANAGE)) throw forbidden("You do not have access to referral requests.");
}

export async function listReferralRequests(status: ReferralRequestStatus | null, actor: Actor): Promise<ReferralRequestView[]> {
  assertManager(actor);
  const rows = await db
    .select()
    .from(referralCodeRequests)
    .where(status ? eq(referralCodeRequests.status, status) : undefined)
    .orderBy(desc(referralCodeRequests.createdAt))
    .limit(300);
  return rows.map(toView);
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = () => "GKS" + Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");

async function decide(
  requestId: string,
  actor: Actor,
  apply: (current: ReferralCodeRequest) => Promise<Partial<ReferralCodeRequest>>,
  decision: "issued" | "rejected",
): Promise<ReferralRequestView> {
  assertManager(actor);
  const [current] = await db.select().from(referralCodeRequests).where(eq(referralCodeRequests.id, requestId));
  if (!current) throw notFound("Request");
  if (current.status !== "NEW") throw conflict(`This request is already ${current.status === "CODE_ISSUED" ? "answered with a code" : "rejected"}.`);
  const patch = await apply(current);
  const [updated] = await db
    .update(referralCodeRequests)
    .set({ ...patch, decidedBy: actor.id, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(referralCodeRequests.id, requestId), eq(referralCodeRequests.status, "NEW")))
    .returning();
  if (!updated) throw conflict("Someone else answered this request just now.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.REFERRAL_REQUEST_DECIDED,
    entityType: "referral_code_request",
    entityId: requestId,
    previousValue: { status: current.status },
    newValue: { status: updated.status, code: updated.issuedCode, note: updated.decisionNote },
  });
  await emitEvent({
    type: "referral_request.decided",
    subjectId: requestId,
    actor,
    payload: {
      requestId,
      name: updated.name,
      city: updated.city,
      pincode: updated.pincode,
      shopTypeLabel: shopTypeLabel(updated.shopType),
      requesterUserId: updated.userId,
      decision,
      code: updated.issuedCode,
      reason: updated.decisionNote,
    },
  });
  return toView(updated);
}

/** Issues a referral code for the request (typed by operations, or generated). */
export async function issueReferralCodeForRequest(requestId: string, input: { code?: string | null; note?: string | null }, actor: Actor): Promise<ReferralRequestView> {
  return decide(
    requestId,
    actor,
    async (current) => {
      let created: Awaited<ReturnType<typeof createReferralCode>> | null = null;
      for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
        const code = input.code?.trim() || randomCode();
        try {
          created = await createReferralCode(
            { code, label: `Requested by ${current.name} (${referralRequestReference(current.id)})`, referrerName: current.name, note: input.note ?? null },
            actor,
          );
        } catch (error) {
          // A generated code that collides is retried; a typed one is the operator's to change.
          if (input.code?.trim() || !(error instanceof AppError && error.code === "CONFLICT")) throw error;
        }
      }
      if (!created) throw conflict("Could not generate a free code — type one instead.");
      return { status: "CODE_ISSUED", issuedCodeId: created.id, issuedCode: created.code, decisionNote: input.note?.trim() || null };
    },
    "issued",
  );
}

export async function rejectReferralRequest(requestId: string, reason: string, actor: Actor): Promise<ReferralRequestView> {
  const note = reason.trim();
  if (note.length < 3) throw validationFailed("Say why the request is rejected.", { fields: { reason: "Required." } });
  return decide(requestId, actor, async () => ({ status: "REJECTED", decisionNote: note }), "rejected");
}

/** Operations re-send the referrals email (e.g. after an email outage). */
export async function resendReferralRequestEmail(requestId: string, actor: Actor): Promise<ReferralRequestView> {
  assertManager(actor);
  const [row] = await db.select().from(referralCodeRequests).where(eq(referralCodeRequests.id, requestId));
  if (!row) throw notFound("Request");
  return toView(await emailReferralsTeam(row));
}

/** Codes that exist (for tests and the admin screen's sanity checks). */
export async function referralCodeExists(code: string): Promise<boolean> {
  const [row] = await db.select({ id: referralCodes.id }).from(referralCodes).where(eq(referralCodes.code, code.trim().toUpperCase()));
  return Boolean(row);
}

/**
 * After a self-service registration: the shop is attributed to the code it
 * registered with (once — a resubmitted shop that already has a code keeps
 * it). Never undoes the registration: a failure is logged for operations.
 */
export async function attributeRegistrationReferral(
  shop: { id: string; referralCodeId: string | null },
  code: string,
  actor: Actor,
): Promise<void> {
  if (shop.referralCodeId) return;
  try {
    await attributeShopToCode(shop.id, code, actor);
  } catch (error) {
    console.error("[referral-requests] could not attribute shop", shop.id, code, error instanceof Error ? error.message : error);
  }
}
