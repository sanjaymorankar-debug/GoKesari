/**
 * Grievance redressal (Part 58 — Information Technology Rules 2021, Rule
 * 3(2), and Consumer Protection Act 2019 §94's grievance mechanism for
 * e-commerce entities).
 *
 * The legal obligation this exists to support: acknowledge a complaint
 * promptly (guidance: within 24 hours) and dispose of it within 15 days of
 * receipt. This file does not enforce those clocks automatically — it
 * records `createdAt` and `resolvedAt` so the admin dashboard can SHOW
 * whether they were met, which is the auditable evidence a Grievance Officer
 * actually needs. Meeting the clock is an operational commitment, not
 * something code can guarantee.
 *
 * Deliberately reachable without authentication: a complaint about being
 * unable to sign in must not itself require signing in (§ "Grievance
 * Redressal" — "maintain a complaint submission form").
 */
import { and, desc, eq, ilike, or } from "drizzle-orm";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  orders,
  grievances,
  type Grievance,
  type GrievanceCategory,
  type GrievanceStatus,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";

interface Actor {
  id: string;
  role: UserRole;
}

export interface SubmitGrievanceInput {
  name: string;
  email: string;
  phone?: string | null;
  category: GrievanceCategory;
  subject: string;
  description: string;
  submittedByUserId?: string | null;
  /** The order this problem is about (GS-056 / WF-007). Must belong to the submitter. */
  orderId?: string | null;
}

function validateEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw validationFailed("Enter a valid email address.");
  }
}

export async function submitGrievance(input: SubmitGrievanceInput): Promise<Grievance> {
  if (input.name.trim().length < 2) {
    throw validationFailed("Enter your name.");
  }
  validateEmail(input.email);
  if (input.subject.trim().length < 3) {
    throw validationFailed("Enter a subject for your complaint.");
  }
  if (input.description.trim().length < 10) {
    throw validationFailed("Describe your complaint in a bit more detail.");
  }

  if (input.orderId) {
    const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
    if (!order || !input.submittedByUserId || order.userId !== input.submittedByUserId) {
      throw notFound("Order");
    }
  }

  const [grievance] = await db
    .insert(grievances)
    .values({
      submittedByUserId: input.submittedByUserId ?? null,
      orderId: input.orderId ?? null,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      phone: input.phone?.trim() || null,
      category: input.category,
      subject: input.subject.trim(),
      description: input.description.trim(),
      status: "OPEN",
    })
    .returning();

  await recordAudit({
    actorId: input.submittedByUserId ?? null,
    action: AUDIT_ACTIONS.GRIEVANCE_SUBMITTED,
    entityType: "grievance",
    entityId: grievance.id,
    newValue: { ticketNumber: grievance.ticketNumber, category: grievance.category },
  });

  // Acknowledgement — the complainant should never be left wondering whether
  // their submission actually landed.
  if (input.submittedByUserId) {
    await notify({
      userId: input.submittedByUserId,
      type: NOTIFICATION_TYPES.GRIEVANCE_ACKNOWLEDGED,
      title: `Complaint received — ${grievance.ticketNumber}`,
      body: "We've received your complaint and will respond as soon as possible.",
      actionUrl: `/grievance/${grievance.ticketNumber}`,
    });
  }

  return grievance;
}

export async function getGrievanceByTicket(ticketNumber: string): Promise<Grievance> {
  const [grievance] = await db
    .select()
    .from(grievances)
    .where(eq(grievances.ticketNumber, ticketNumber.trim().toUpperCase()));
  if (!grievance) throw notFound("Grievance");
  return grievance;
}

/**
 * Public status lookup. Requires the SAME email the grievance was filed
 * with — this is deliberately not just "anyone with the ticket number", so a
 * guessed/leaked ticket number cannot be used to read someone else's
 * complaint details (§ "Do not expose private grievance information publicly").
 */
export async function lookupGrievance(
  ticketNumber: string,
  email: string,
): Promise<Grievance> {
  const grievance = await getGrievanceByTicket(ticketNumber);
  if (grievance.email !== email.trim().toLowerCase()) {
    throw forbidden("That ticket number and email do not match.");
  }
  return grievance;
}

export interface GrievanceFilters {
  status?: GrievanceStatus;
  category?: GrievanceCategory;
  search?: string;
  limit?: number;
}

export async function listGrievances(filters: GrievanceFilters = {}): Promise<Grievance[]> {
  const conditions = [];
  if (filters.status) conditions.push(eq(grievances.status, filters.status));
  if (filters.category) conditions.push(eq(grievances.category, filters.category));
  if (filters.search) {
    const term = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(grievances.ticketNumber, term),
        ilike(grievances.email, term),
        ilike(grievances.subject, term),
      )!,
    );
  }

  return db
    .select()
    .from(grievances)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(grievances.createdAt))
    .limit(filters.limit ?? 200);
}

export interface GrievanceDashboard {
  open: number;
  inProgress: number;
  resolved: number;
  closed: number;
  total: number;
  /** Still OPEN more than 15 days after submission — the Rule 3(2) breach signal. */
  overdue: number;
}

export async function getGrievanceDashboard(): Promise<GrievanceDashboard> {
  const all = await db.select().from(grievances);
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

  return {
    open: all.filter((g) => g.status === "OPEN").length,
    inProgress: all.filter((g) => g.status === "IN_PROGRESS").length,
    resolved: all.filter((g) => g.status === "RESOLVED").length,
    closed: all.filter((g) => g.status === "CLOSED").length,
    total: all.length,
    overdue: all.filter(
      (g) => (g.status === "OPEN" || g.status === "IN_PROGRESS") && g.createdAt < fifteenDaysAgo,
    ).length,
  };
}

export async function assignGrievance(
  id: string,
  assignedToUserId: string,
  actor: Actor,
): Promise<Grievance> {
  const current = await db.query.grievances.findFirst({ where: eq(grievances.id, id) });
  if (!current) throw notFound("Grievance");

  const [updated] = await db
    .update(grievances)
    .set({
      assignedToUserId,
      status: current.status === "OPEN" ? "IN_PROGRESS" : current.status,
      updatedAt: new Date(),
    })
    .where(eq(grievances.id, id))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.GRIEVANCE_UPDATED,
    entityType: "grievance",
    entityId: id,
    previousValue: { assignedToUserId: current.assignedToUserId, status: current.status },
    newValue: { assignedToUserId, status: updated.status },
  });
  return updated;
}

export async function resolveGrievance(
  id: string,
  resolutionNotes: string,
  actor: Actor,
): Promise<Grievance> {
  if (resolutionNotes.trim().length < 5) {
    throw validationFailed("Describe how this complaint was resolved.");
  }
  const current = await db.query.grievances.findFirst({ where: eq(grievances.id, id) });
  if (!current) throw notFound("Grievance");

  const [updated] = await db
    .update(grievances)
    .set({
      status: "RESOLVED",
      resolutionNotes: resolutionNotes.trim(),
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(grievances.id, id))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.GRIEVANCE_RESOLVED,
    entityType: "grievance",
    entityId: id,
    previousValue: { status: current.status },
    newValue: { status: "RESOLVED", resolutionNotes },
  });

  if (current.submittedByUserId) {
    await notify({
      userId: current.submittedByUserId,
      type: NOTIFICATION_TYPES.GRIEVANCE_RESOLVED,
      title: `Complaint resolved — ${current.ticketNumber}`,
      body: resolutionNotes.trim(),
      actionUrl: `/grievance/${current.ticketNumber}`,
    });
  }
  return updated;
}

export async function setGrievanceStatus(
  id: string,
  status: GrievanceStatus,
  actor: Actor,
): Promise<Grievance> {
  const current = await db.query.grievances.findFirst({ where: eq(grievances.id, id) });
  if (!current) throw notFound("Grievance");

  const [updated] = await db
    .update(grievances)
    .set({ status, updatedAt: new Date() })
    .where(eq(grievances.id, id))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.GRIEVANCE_UPDATED,
    entityType: "grievance",
    entityId: id,
    previousValue: { status: current.status },
    newValue: { status },
  });
  return updated;
}
