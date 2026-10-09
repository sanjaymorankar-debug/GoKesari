/**
 * Customer referral-code requests (docs/four-features-2026-10, the owner's
 * decision of 9 Oct 2026). A referral code is mandatory for customers (rule
 * customerSignupReferral.required). A customer without one asks for it from
 * My referral code with their location (when they share it), PIN code, city
 * and contact number. The request is saved, operations are told in the app,
 * and the referrals team gets an email (rule shopReferral.notifyEmails, the
 * same list as shop owners' requests). GoKesari then sends someone, or issues
 * a code (an ordinary referral code), or declines. The customer is told in
 * the app and by email, and enters the code to start ordering. One request
 * per customer or mobile number within requestDuplicateWindowHours.
 */
import crypto from "node:crypto";

import { and, desc, eq, gte, or, sql } from "drizzle-orm";

import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { maskPhone } from "@/lib/phone";
import { checkCustomerReferralRequest, customerReferralRequestReference, type CustomerReferralRequestInput } from "@/lib/referral-requests";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { customerReferralRequests, type CustomerReferralRequest, type ReferralRequestStatus, type UserRole } from "@/server/db/schema";
import { emailMode, sendEmail } from "@/server/email/transport";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { createReferralCode } from "./referrals";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

export interface CustomerReferralRequestView {
  id: string;
  reference: string;
  name: string;
  mobile: string;
  city: string;
  pincode: string;
  latitude: string | null;
  longitude: string | null;
  mapsUrl: string | null;
  locationStatus: "SHARED" | "NOT_SHARED";
  status: ReferralRequestStatus;
  issuedCode: string | null;
  decisionNote: string | null;
  emailStatus: "SENT" | "FAILED" | "NOT_CONFIGURED" | null;
  emailError: string | null;
  createdAt: string;
  decidedAt: string | null;
}

function toView(row: CustomerReferralRequest): CustomerReferralRequestView {
  return {
    id: row.id,
    reference: customerReferralRequestReference(row.id),
    name: row.name,
    mobile: row.mobileE164,
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

/** An identical request from the same customer within this time is answered as the first one. */
const REPLAY_WINDOW_MS = 2 * 60_000;

const istTime = (at: Date) =>
  at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST";

function emailFor(row: CustomerReferralRequest, email: string): { subject: string; text: string; html: string } {
  const reference = customerReferralRequestReference(row.id);
  const coordinates = row.latitude && row.longitude ? `${row.latitude}, ${row.longitude}${row.locationAccuracyM ? ` (±${row.locationAccuracyM} m)` : ""}` : "Not shared";
  const lines: [string, string][] = [
    ["Reference", reference],
    ["Name", row.name],
    ["Contact number", row.mobileE164],
    ["Email", email],
    ["City", row.city],
    ["PIN code", row.pincode],
    ["Location", row.locationStatus === "SHARED" ? "Shared from the browser / app" : "Not shared (permission denied or unavailable)"],
    ["Coordinates", coordinates],
    ["Google Maps", row.mapsUrl ?? "—"],
    ["Requested at", istTime(row.createdAt)],
  ];
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    subject: `Customer referral code request ${reference} — ${row.name}, ${row.city} ${row.pincode}`,
    text: `A customer has asked for a GoKesari referral code.\n\n${lines.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nSend someone, or issue a code, in Admin → Referral requests.`,
    html:
      `<p>A customer has asked for a GoKesari referral code.</p><table cellpadding="4">` +
      lines
        .map(([k, v]) => `<tr><td><b>${escape(k)}</b></td><td>${v.startsWith("https://") ? `<a href="${escape(v)}">${escape(v)}</a>` : escape(v)}</td></tr>`)
        .join("") +
      `</table><p>Send someone, or issue a code, in Admin → Referral requests.</p>`,
  };
}

/** Sends (or re-sends) the referrals email and records how it went. Never throws. */
async function emailReferralsTeam(row: CustomerReferralRequest): Promise<CustomerReferralRequest> {
  const rule = await getRule("shopReferral");
  let status: "SENT" | "FAILED" | "NOT_CONFIGURED" = "SENT";
  let error: string | null = null;
  if (emailMode() === "disabled") {
    status = "NOT_CONFIGURED";
    error = "Email is not configured on this site (AUTH_EMAIL_FROM / AUTH_EMAIL_SERVER).";
  } else {
    const user = await db.query.users.findFirst({ where: (u, { eq: is }) => is(u.id, row.userId), columns: { email: true } });
    const message = emailFor(row, user?.email ?? "—");
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
    .update(customerReferralRequests)
    .set({ emailStatus: status, emailError: error, emailSentAt: status === "SENT" ? new Date() : row.emailSentAt, updatedAt: new Date() })
    .where(eq(customerReferralRequests.id, row.id))
    .returning();
  if (status !== "SENT") console.error("[customer-referral-requests] email not sent", customerReferralRequestReference(row.id), status, error);
  return updated;
}

/** The signed-in customer asks for a referral code. */
export async function createCustomerReferralRequest(
  input: CustomerReferralRequestInput,
  userId: string,
): Promise<{ reference: string; createdAt: string; mobileMasked: string; locationShared: boolean }> {
  const rules = await getRule("customerSignupReferral");
  if (!rules.enabled) throw conflict("Referral codes aren't asked for right now.");
  const checked = checkCustomerReferralRequest(input);
  if (!checked.ok) throw validationFailed(Object.values(checked.fields)[0], { fields: checked.fields });
  const request = checked.value;

  const { row, replayed } = await db.transaction(async (tx) => {
    // One at a time per customer, so two quick taps make one request.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`customer-referral-request:${userId}`}))`);
    const since = new Date(Date.now() - rules.requestDuplicateWindowHours * 3_600_000);
    const [recent] = await tx
      .select()
      .from(customerReferralRequests)
      .where(
        and(
          or(eq(customerReferralRequests.userId, userId), eq(customerReferralRequests.mobileE164, request.mobileE164)),
          gte(customerReferralRequests.createdAt, since),
        ),
      )
      .orderBy(desc(customerReferralRequests.createdAt))
      .limit(1);
    // The same request again from the same customer moments later (a double tap, or the host's CDN
    // answering the first POST with a 307 that the browser repeats) is the same request: answer it again.
    if (
      recent &&
      recent.userId === userId &&
      Date.now() - recent.createdAt.getTime() < REPLAY_WINDOW_MS &&
      recent.mobileE164 === request.mobileE164 &&
      recent.city === request.city &&
      recent.pincode === request.pincode
    ) {
      return { row: recent, replayed: true };
    }
    if (recent) {
      throw new AppError(
        "RATE_LIMITED",
        `We already have your request (${customerReferralRequestReference(recent.id)}, ${istTime(recent.createdAt)}). Our team will contact you — there is no need to ask again.`,
        { reference: customerReferralRequestReference(recent.id) },
      );
    }
    const [created] = await tx
      .insert(customerReferralRequests)
      .values({
        userId,
        name: request.name,
        mobileE164: request.mobileE164,
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
        actorId: userId,
        action: AUDIT_ACTIONS.CUSTOMER_REFERRAL_REQUEST_CREATED,
        entityType: "customer_referral_request",
        entityId: created.id,
        newValue: { mobile: maskPhone(created.mobileE164), city: created.city, pincode: created.pincode, locationStatus: created.locationStatus },
      },
      tx,
    );
    await emitEvent(
      {
        type: "customer_referral_request.created",
        subjectId: created.id,
        actor: { id: userId, role: null },
        payload: {
          requestId: created.id,
          reference: customerReferralRequestReference(created.id),
          name: created.name,
          city: created.city,
          pincode: created.pincode,
          requesterUserId: userId,
        },
      },
      tx,
    );
    return { row: created, replayed: false };
  });

  if (!replayed) await emailReferralsTeam(row);
  return {
    reference: customerReferralRequestReference(row.id),
    createdAt: row.createdAt.toISOString(),
    mobileMasked: maskPhone(row.mobileE164),
    locationShared: row.locationStatus === "SHARED",
  };
}

/** The customer's own requests (newest first) — with the code once one is issued. */
export async function listMyCustomerReferralRequests(userId: string): Promise<CustomerReferralRequestView[]> {
  const rows = await db
    .select()
    .from(customerReferralRequests)
    .where(eq(customerReferralRequests.userId, userId))
    .orderBy(desc(customerReferralRequests.createdAt))
    .limit(5);
  return rows.map(toView);
}

/* =========================================================== operations */

function assertManager(actor: Actor) {
  if (!can(actor.role, PERMISSIONS.REFERRAL_MANAGE)) throw forbidden("You do not have access to referral requests.");
}

export async function listCustomerReferralRequests(status: ReferralRequestStatus | null, actor: Actor): Promise<CustomerReferralRequestView[]> {
  assertManager(actor);
  const rows = await db
    .select()
    .from(customerReferralRequests)
    .where(status ? eq(customerReferralRequests.status, status) : undefined)
    .orderBy(desc(customerReferralRequests.createdAt))
    .limit(300);
  return rows.map(toView);
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = () => "GKC" + Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");

async function decide(
  requestId: string,
  actor: Actor,
  apply: (current: CustomerReferralRequest) => Promise<Partial<CustomerReferralRequest>>,
  decision: "issued" | "rejected",
): Promise<CustomerReferralRequestView> {
  assertManager(actor);
  const [current] = await db.select().from(customerReferralRequests).where(eq(customerReferralRequests.id, requestId));
  if (!current) throw notFound("Request");
  if (current.status !== "NEW") throw conflict(`This request is already ${current.status === "CODE_ISSUED" ? "answered with a code" : "declined"}.`);
  const patch = await apply(current);
  const [updated] = await db
    .update(customerReferralRequests)
    .set({ ...patch, decidedBy: actor.id, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(customerReferralRequests.id, requestId), eq(customerReferralRequests.status, "NEW")))
    .returning();
  if (!updated) throw conflict("Someone else answered this request just now.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CUSTOMER_REFERRAL_REQUEST_DECIDED,
    entityType: "customer_referral_request",
    entityId: requestId,
    previousValue: { status: current.status },
    newValue: { status: updated.status, code: updated.issuedCode, note: updated.decisionNote },
  });
  await emitEvent({
    type: "customer_referral_request.decided",
    subjectId: requestId,
    actor,
    payload: {
      requestId,
      reference: customerReferralRequestReference(requestId),
      name: updated.name,
      city: updated.city,
      pincode: updated.pincode,
      requesterUserId: updated.userId,
      decision,
      code: updated.issuedCode,
      reason: updated.decisionNote,
    },
  });
  return toView(updated);
}

/** Issues a referral code for the customer (typed by operations, or generated); they are told at once. */
export async function issueCodeForCustomerRequest(requestId: string, input: { code?: string | null; note?: string | null }, actor: Actor): Promise<CustomerReferralRequestView> {
  return decide(
    requestId,
    actor,
    async (current) => {
      let created: Awaited<ReturnType<typeof createReferralCode>> | null = null;
      for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
        const code = input.code?.trim() || randomCode();
        try {
          created = await createReferralCode(
            { code, label: `Customer ${current.name} (${customerReferralRequestReference(current.id)})`, referrerName: current.name, note: input.note ?? null },
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

export async function rejectCustomerReferralRequest(requestId: string, reason: string, actor: Actor): Promise<CustomerReferralRequestView> {
  const note = reason.trim();
  if (note.length < 3) throw validationFailed("Say why the request is declined.", { fields: { reason: "Required." } });
  return decide(requestId, actor, async () => ({ status: "REJECTED", decisionNote: note }), "rejected");
}

/** Operations re-send the referrals email (e.g. after an email outage). */
export async function resendCustomerReferralRequestEmail(requestId: string, actor: Actor): Promise<CustomerReferralRequestView> {
  assertManager(actor);
  const [row] = await db.select().from(customerReferralRequests).where(eq(customerReferralRequests.id, requestId));
  if (!row) throw notFound("Request");
  return toView(await emailReferralsTeam(row));
}
