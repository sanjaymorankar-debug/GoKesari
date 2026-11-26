/**
 * Rider insurance (Rider App v2, rule riderInsurance, OFF by default).
 *
 * Admin keeps the group policy on Admin → Rider insurance (insurer, policy number, covers in
 * paise, eligibility = at least minDeliveries DELIVERED in the last lookbackDays, valid dates,
 * network hospitals, claim help). Only one policy is active at a time: activating one switches
 * the others off. Riders see their coverage card, add a nominee and raise a claim (a help-desk
 * ticket, files attached with the ticket's own upload).
 *
 * The rider view carries only the rider's own data and the policy's — never customer details,
 * order totals, fees, commission or shop charges.
 *
 * Notifications (RIDER_INSURANCE_STATUS) go out after the DB writes, queued (deferDelivery) for
 * the notifications cron, to at most 2000 riders eligible when a policy is activated.
 */
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { istDateKey } from "@/lib/consult/time";
import { insuranceEligibility, isIsoDate, nomineeErrors, type InsuranceEligibility } from "@/lib/rider-safety";
import { createTicket } from "@/server/aftercare/support-tickets";
import { db } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  riderInsurancePolicies,
  riderNominees,
  type NetworkHospital,
  type RiderInsurancePolicy,
  type RiderNominee,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { notify } from "./notifications";
import { getRule } from "./settings";

export interface Actor {
  id: string;
  role: UserRole;
}

export const INSURANCE_NOTIFY_CAP = 2000;

export async function riderInsuranceEnabled(): Promise<boolean> {
  return (await getRule("riderInsurance")).enabled;
}

export async function getActivePolicy(): Promise<RiderInsurancePolicy | null> {
  const [row] = await db
    .select()
    .from(riderInsurancePolicies)
    .where(eq(riderInsurancePolicies.isActive, true))
    .orderBy(desc(riderInsurancePolicies.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function listPolicies(): Promise<RiderInsurancePolicy[]> {
  return db.select().from(riderInsurancePolicies).orderBy(desc(riderInsurancePolicies.isActive), desc(riderInsurancePolicies.updatedAt)).limit(100);
}

/* ------------------------------------------------------------ admin: save */

export interface PolicyInput {
  insurer: string;
  policyNumber: string;
  healthCoverPaise: number;
  accidentCoverPaise: number;
  opdCoverPaise: number;
  minDeliveries: number;
  lookbackDays: number;
  validFrom: string;
  validTo: string;
  hospitalsUrl?: string | null;
  hospitals: NetworkHospital[];
  claimHelp?: string | null;
  isActive: boolean;
}

function policyErrors(input: PolicyInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (input.insurer.trim().length < 2) errors.insurer = "Enter the insurer's name.";
  if (input.policyNumber.trim().length < 2) errors.policyNumber = "Enter the policy number.";
  for (const key of ["healthCoverPaise", "accidentCoverPaise", "opdCoverPaise"] as const) {
    if (!Number.isInteger(input[key]) || input[key] < 0) errors[key] = "Enter an amount of zero or more.";
  }
  if (!Number.isInteger(input.minDeliveries) || input.minDeliveries < 0 || input.minDeliveries > 10_000) errors.minDeliveries = "0 to 10000.";
  if (!Number.isInteger(input.lookbackDays) || input.lookbackDays < 1 || input.lookbackDays > 366) errors.lookbackDays = "1 to 366 days.";
  if (!isIsoDate(input.validFrom)) errors.validFrom = "Enter a valid date.";
  if (!isIsoDate(input.validTo)) errors.validTo = "Enter a valid date.";
  else if (isIsoDate(input.validFrom) && input.validTo < input.validFrom) errors.validTo = "Must be on or after the start date.";
  if (input.hospitalsUrl && !/^https:\/\/\S+$/i.test(input.hospitalsUrl.trim())) errors.hospitalsUrl = "Enter a link starting with https://";
  if (input.hospitals.length > 500) errors.hospitals = "At most 500 hospitals; use the link for a longer list.";
  input.hospitals.forEach((h, i) => {
    if (!h.name?.trim() || !h.city?.trim()) errors[`hospitals.${i}`] = "Each hospital needs a name and a city.";
  });
  return errors;
}

function cleanHospitals(list: NetworkHospital[]): NetworkHospital[] {
  return list.map((h) => ({
    name: h.name.trim(),
    city: h.city.trim(),
    ...(h.address?.trim() ? { address: h.address.trim() } : {}),
    ...(h.phone?.trim() ? { phone: h.phone.trim() } : {}),
  }));
}

/** Create (id omitted) or edit a policy. Activating it switches every other policy off. */
export async function savePolicy(input: PolicyInput, actor: Actor, id?: string | null): Promise<RiderInsurancePolicy> {
  const errors = policyErrors(input);
  if (Object.keys(errors).length) throw validationFailed("Please check the highlighted fields.", { fields: errors });

  const values = {
    insurer: input.insurer.trim(),
    policyNumber: input.policyNumber.trim(),
    healthCoverPaise: input.healthCoverPaise,
    accidentCoverPaise: input.accidentCoverPaise,
    opdCoverPaise: input.opdCoverPaise,
    minDeliveries: input.minDeliveries,
    lookbackDays: input.lookbackDays,
    validFrom: input.validFrom,
    validTo: input.validTo,
    hospitalsUrl: input.hospitalsUrl?.trim() || null,
    hospitals: cleanHospitals(input.hospitals),
    claimHelp: input.claimHelp?.trim() || null,
    isActive: input.isActive,
    updatedAt: new Date(),
  };

  const { saved, becameActive } = await db.transaction(async (tx) => {
    // One active policy at a time: serialise saves.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('rider_insurance_policy'))`);
    let before: RiderInsurancePolicy | null = null;
    if (id) {
      const [row] = await tx.select().from(riderInsurancePolicies).where(eq(riderInsurancePolicies.id, id)).for("update");
      if (!row) throw notFound("Policy");
      before = row;
    }
    const [saved] = id
      ? await tx.update(riderInsurancePolicies).set(values).where(eq(riderInsurancePolicies.id, id)).returning()
      : await tx.insert(riderInsurancePolicies).values({ ...values, createdBy: actor.id }).returning();
    let deactivated: string[] = [];
    if (saved.isActive) {
      const off = await tx
        .update(riderInsurancePolicies)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(riderInsurancePolicies.isActive, true), ne(riderInsurancePolicies.id, saved.id)))
        .returning({ id: riderInsurancePolicies.id });
      deactivated = off.map((r) => r.id);
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RIDER_INSURANCE_POLICY_SAVED,
        entityType: "rider_insurance_policy",
        entityId: saved.id,
        previousValue: before ? { ...before, hospitals: before.hospitals.length } : null,
        newValue: { ...values, hospitals: values.hospitals.length, deactivatedPolicyIds: deactivated },
      },
      tx,
    );
    return { saved, becameActive: saved.isActive && !before?.isActive };
  });

  if (becameActive) {
    await notifyEligibleRiders(saved).catch((error) => console.error("[rider-insurance] status notifications failed", error));
  }
  return saved;
}

/** Switch a policy on or off without editing it. */
export async function setPolicyActive(id: string, isActive: boolean, actor: Actor): Promise<RiderInsurancePolicy> {
  const [row] = await db.select().from(riderInsurancePolicies).where(eq(riderInsurancePolicies.id, id));
  if (!row) throw notFound("Policy");
  return savePolicy(
    {
      insurer: row.insurer,
      policyNumber: row.policyNumber,
      healthCoverPaise: row.healthCoverPaise,
      accidentCoverPaise: row.accidentCoverPaise,
      opdCoverPaise: row.opdCoverPaise,
      minDeliveries: row.minDeliveries,
      lookbackDays: row.lookbackDays,
      validFrom: row.validFrom,
      validTo: row.validTo,
      hospitalsUrl: row.hospitalsUrl,
      hospitals: row.hospitals,
      claimHelp: row.claimHelp,
      isActive,
    },
    actor,
    id,
  );
}

/** Riders (users) eligible under a policy right now — approved, enough DELIVERED in the window. */
async function eligibleRiderUserIds(policy: RiderInsurancePolicy, cap = INSURANCE_NOTIFY_CAP): Promise<string[]> {
  const today = istDateKey(new Date());
  if (!(policy.validFrom <= today && today <= policy.validTo)) return [];
  const since = new Date(Date.now() - policy.lookbackDays * 86_400_000);
  const rows = await db
    .select({ userId: deliveryPartners.userId })
    .from(deliveryPartners)
    .leftJoin(
      deliveryOrders,
      and(eq(deliveryOrders.deliveryPartnerId, deliveryPartners.id), eq(deliveryOrders.status, "DELIVERED"), gte(deliveryOrders.deliveredAt, since)),
    )
    .where(eq(deliveryPartners.status, "APPROVED"))
    .groupBy(deliveryPartners.userId)
    .having(sql`count(${deliveryOrders.id}) >= ${policy.minDeliveries}`)
    .limit(cap);
  return rows.map((r) => r.userId);
}

async function notifyEligibleRiders(policy: RiderInsurancePolicy): Promise<number> {
  if (!(await riderInsuranceEnabled())) return 0;
  const userIds = await eligibleRiderUserIds(policy);
  for (const userId of userIds) {
    await notify({
      userId,
      type: "delivery.rider_insurance_status",
      vars: { status: "active" },
      actionUrl: "/delivery-partner/insurance",
      channels: ["PUSH"],
      lang: "auto",
      dedupeKey: `rider-insurance:${policy.id}:${userId}:active`,
      deferDelivery: true,
    });
  }
  return userIds.length;
}

/* ------------------------------------------------------------- rider view */

export interface RiderInsuranceView {
  enabled: boolean;
  riderName: string;
  policy: {
    insurer: string;
    policyNumber: string;
    healthCoverPaise: number;
    accidentCoverPaise: number;
    opdCoverPaise: number;
    minDeliveries: number;
    lookbackDays: number;
    validFrom: string;
    validTo: string;
    hospitalsUrl: string | null;
    hospitals: NetworkHospital[];
    claimHelp: string | null;
  } | null;
  deliveredInWindow: number;
  eligibility: InsuranceEligibility | null;
  nominee: { name: string; relation: string; mobile: string | null; dateOfBirth: string | null } | null;
}

async function myPartner(userId: string) {
  const [partner] = await db
    .select({ id: deliveryPartners.id, fullName: deliveryPartners.fullName })
    .from(deliveryPartners)
    .where(eq(deliveryPartners.userId, userId));
  return partner ?? null;
}

async function deliveredSince(partnerId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deliveryOrders)
    .where(and(eq(deliveryOrders.deliveryPartnerId, partnerId), eq(deliveryOrders.status, "DELIVERED"), gte(deliveryOrders.deliveredAt, since)));
  return row?.n ?? 0;
}

/** Null when the caller has no delivery-partner profile. */
export async function getMyInsuranceView(userId: string): Promise<RiderInsuranceView | null> {
  const partner = await myPartner(userId);
  if (!partner) return null;
  const enabled = await riderInsuranceEnabled();
  const base: RiderInsuranceView = { enabled, riderName: partner.fullName, policy: null, deliveredInWindow: 0, eligibility: null, nominee: null };
  if (!enabled) return base;
  const [policy, nominee] = await Promise.all([
    getActivePolicy(),
    db
      .select()
      .from(riderNominees)
      .where(eq(riderNominees.deliveryPartnerId, partner.id))
      .then((rows): RiderNominee | undefined => rows[0]),
  ]);
  base.nominee = nominee ? { name: nominee.name, relation: nominee.relation, mobile: nominee.mobile, dateOfBirth: nominee.dateOfBirth } : null;
  if (!policy) return base;
  const delivered = await deliveredSince(partner.id, new Date(Date.now() - policy.lookbackDays * 86_400_000));
  return {
    ...base,
    policy: {
      insurer: policy.insurer,
      policyNumber: policy.policyNumber,
      healthCoverPaise: policy.healthCoverPaise,
      accidentCoverPaise: policy.accidentCoverPaise,
      opdCoverPaise: policy.opdCoverPaise,
      minDeliveries: policy.minDeliveries,
      lookbackDays: policy.lookbackDays,
      validFrom: policy.validFrom,
      validTo: policy.validTo,
      hospitalsUrl: policy.hospitalsUrl,
      hospitals: policy.hospitals,
      claimHelp: policy.claimHelp,
    },
    deliveredInWindow: delivered,
    eligibility: insuranceEligibility({
      isActive: policy.isActive,
      validFrom: policy.validFrom,
      validTo: policy.validTo,
      minDeliveries: policy.minDeliveries,
      deliveredInWindow: delivered,
      today: istDateKey(new Date()),
    }),
  };
}

export interface NomineeInput {
  name: string;
  relation: string;
  mobile?: string | null;
  dateOfBirth?: string | null;
}

export async function saveMyNominee(actor: Actor, input: NomineeInput) {
  if (!(await riderInsuranceEnabled())) throw forbidden("Rider insurance is not switched on.");
  const partner = await myPartner(actor.id);
  if (!partner) throw notFound("Delivery partner profile");
  const errors = nomineeErrors(input, istDateKey(new Date()));
  if (Object.keys(errors).length) throw validationFailed("Please check the highlighted fields.", { fields: errors });
  const next = {
    name: input.name.trim(),
    relation: input.relation.trim(),
    mobile: input.mobile?.trim() || null,
    dateOfBirth: input.dateOfBirth?.trim() || null,
  };
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(riderNominees).where(eq(riderNominees.deliveryPartnerId, partner.id));
    const [saved] = await tx
      .insert(riderNominees)
      .values({ deliveryPartnerId: partner.id, ...next })
      .onConflictDoUpdate({ target: riderNominees.deliveryPartnerId, set: { ...next, updatedAt: new Date() } })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RIDER_NOMINEE_SAVED,
        entityType: "delivery_partner",
        entityId: partner.id,
        previousValue: before ? { name: before.name, relation: before.relation, mobile: before.mobile, dateOfBirth: before.dateOfBirth } : null,
        newValue: next,
      },
      tx,
    );
    return { name: saved.name, relation: saved.relation, mobile: saved.mobile, dateOfBirth: saved.dateOfBirth };
  });
}

/**
 * The rider raises an insurance claim: a help-desk ticket (category OTHER — the help desk has
 * no insurance category yet) naming the policy. Files go on the ticket afterwards through
 * POST /api/support/tickets/{id}/attachments.
 */
export async function raiseInsuranceClaim(actor: Actor, input: { description: string; incidentDate?: string | null }) {
  if (!(await riderInsuranceEnabled())) throw forbidden("Rider insurance is not switched on.");
  const partner = await myPartner(actor.id);
  if (!partner) throw notFound("Delivery partner profile");
  const policy = await getActivePolicy();
  if (!policy) throw conflict("There is no active insurance policy yet.");
  const description = input.description.trim();
  if (description.length < 10) throw validationFailed("Describe what happened in a bit more detail.", { fields: { description: "Too short." } });
  const incident = input.incidentDate && isIsoDate(input.incidentDate) ? input.incidentDate : null;
  const ticket = await createTicket(
    {
      category: "OTHER",
      subject: `Rider insurance claim — ${policy.insurer} policy ${policy.policyNumber}`.slice(0, 200),
      description: [
        `Rider: ${partner.fullName}`,
        `Policy: ${policy.insurer}, ${policy.policyNumber}`,
        incident ? `Date of incident: ${incident}` : null,
        "",
        description,
      ]
        .filter((line) => line !== null)
        .join("\n")
        .slice(0, 5000),
      priority: "HIGH",
    },
    actor,
  );
  return { id: ticket.id, ticketNumber: ticket.ticketNumber };
}

/** For tests and the admin page: how many riders a policy covers right now (capped). */
export async function countEligibleRiders(policyId: string): Promise<number> {
  const [policy] = await db.select().from(riderInsurancePolicies).where(eq(riderInsurancePolicies.id, policyId));
  if (!policy) return 0;
  return (await eligibleRiderUserIds(policy, 10_000)).length;
}

export const _test = { policyErrors };
