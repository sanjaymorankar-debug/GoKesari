/**
 * Referral code at customer registration (docs/four-features-2026-10, decided
 * by the owner on 9 Oct 2026; rule customerSignupReferral).
 *
 * GoKesari runs its referral schemes and issues the codes (Admin → Referral
 * codes); the app checks a code whenever someone registers — a shop owner at
 * shop registration (referral-requests.ts, rule shopReferral) and a customer
 * at their first-time setup (here). A customer's code may be:
 *   - a code GoKesari issued — active and unexpired (referrals.ts
 *     resolveUsableCode, the same check shop registration uses); recorded
 *     against the customer;
 *   - a friend's code (rule customerReferrals) — handed to the existing friend
 *     referral (customer-referrals.ts applyReferralCode), whose own checks
 *     and reward apply unchanged.
 * Once per customer, and only before their first order.
 */
import { count, eq, sql } from "drizzle-orm";

import { AppError, conflict, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { customerReferralCodes, customerSignupReferrals, orders, referralCodes, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { applyReferralCode, normalizeReferralCode } from "./customer-referrals";
import { resolveUsableCode } from "./referrals";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

export interface SignupReferralView {
  kind: "GOKESARI" | "FRIEND";
  code: string;
  /** GOKESARI: the code's label (scheme / partner), when it has one. */
  label: string | null;
  createdAt: string;
}

export async function getSignupReferral(userId: string): Promise<SignupReferralView | null> {
  const [row] = await db
    .select({ row: customerSignupReferrals, label: referralCodes.label })
    .from(customerSignupReferrals)
    .leftJoin(referralCodes, eq(referralCodes.id, customerSignupReferrals.referralCodeId))
    .where(eq(customerSignupReferrals.userId, userId));
  return row ? { kind: row.row.kind, code: row.row.code, label: row.label, createdAt: row.row.createdAt.toISOString() } : null;
}

/** Whether first-time setup should ask this customer for a code. */
export async function shouldAskSignupReferral(userId: string): Promise<boolean> {
  if (!(await getRule("customerSignupReferral")).enabled) return false;
  if (await getSignupReferral(userId)) return false;
  const [{ n }] = await db.select({ n: count() }).from(orders).where(eq(orders.userId, userId));
  return n === 0;
}

/** Checks the code a new customer gave and records it. */
export async function applySignupReferralCode(userId: string, raw: string, actor: Actor): Promise<SignupReferralView> {
  if (!(await getRule("customerSignupReferral")).enabled) throw conflict("Referral codes aren't asked for right now.");
  // Issued codes keep hyphens / underscores (referrals.ts); friends' codes are letters and digits only.
  const entered = raw.trim().toUpperCase();
  const friendCode = normalizeReferralCode(raw);
  if (!entered) throw validationFailed("Enter a referral code.", { fields: { referralCode: "Enter a referral code." } });
  const existing = await getSignupReferral(userId);
  if (existing) {
    if (existing.code === entered || existing.code === friendCode) return existing;
    throw conflict("You have already given a referral code.");
  }
  const [{ n }] = await db.select({ n: count() }).from(orders).where(eq(orders.userId, userId));
  if (n > 0) throw conflict("A referral code can only be given when you join, before your first order.");

  // A code GoKesari issued first; then a friend's code.
  let issued: Awaited<ReturnType<typeof resolveUsableCode>> | null = null;
  try {
    issued = await resolveUsableCode(entered);
  } catch (error) {
    const unknown = error instanceof AppError && error.code === "VALIDATION_FAILED" && /does not exist/.test(error.message);
    if (!unknown) throw invalid(error);
  }
  if (!issued) {
    const friend = friendCode ? await db.query.customerReferralCodes.findFirst({ where: eq(customerReferralCodes.code, friendCode) }) : null;
    if (!friend || !(await getRule("customerReferrals")).enabled) {
      throw validationFailed("This referral code is not valid.", { fields: { referralCode: "This referral code is not valid." } });
    }
    await applyReferralCode(userId, friendCode).catch((error) => {
      throw invalid(error);
    });
  }

  const [row] = await db
    .insert(customerSignupReferrals)
    .values({ userId, kind: issued ? "GOKESARI" : "FRIEND", referralCodeId: issued?.id ?? null, code: issued?.code ?? friendCode })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict("You have already given a referral code.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CUSTOMER_SIGNUP_REFERRAL,
    entityType: "customer_signup_referral",
    entityId: row.id,
    newValue: { kind: row.kind, code: row.code, referralCodeId: row.referralCodeId },
  });
  return { kind: row.kind, code: row.code, label: issued?.label ?? null, createdAt: row.createdAt.toISOString() };
}

/** A validation error about the code, shown on the field. */
function invalid(error: unknown): unknown {
  if (error instanceof AppError && (error.code === "VALIDATION_FAILED" || error.code === "CONFLICT")) {
    return validationFailed(error.message, { fields: { referralCode: error.message } });
  }
  return error;
}

/* ============================================================= admin */

export interface SignupReferralAdminRow {
  code: string;
  label: string | null;
  kind: "GOKESARI" | "FRIEND";
  customers: number;
  latestAt: string;
}

/** Admin: how many customers joined with each code (newest first). */
export async function listSignupReferralCounts(): Promise<SignupReferralAdminRow[]> {
  const rows = await db
    .select({
      code: customerSignupReferrals.code,
      kind: customerSignupReferrals.kind,
      label: referralCodes.label,
      customers: count(),
      latestAt: sql<string>`max(${customerSignupReferrals.createdAt})`,
    })
    .from(customerSignupReferrals)
    .leftJoin(referralCodes, eq(referralCodes.id, customerSignupReferrals.referralCodeId))
    .groupBy(customerSignupReferrals.code, customerSignupReferrals.kind, referralCodes.label)
    .limit(200);
  return rows
    .map((r) => ({ code: r.code, kind: r.kind, label: r.label, customers: Number(r.customers), latestAt: new Date(r.latestAt).toISOString() }))
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}
