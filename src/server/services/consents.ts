/**
 * User consent record (Part 58 — Digital Personal Data Protection Act 2023
 * §6: consent must be free, specific, informed, unconditional and
 * unambiguous, with clear affirmative action, and the Data Fiduciary must be
 * able to demonstrate it was given).
 *
 * "Demonstrate" is the operative word this file exists for — a consent that
 * only lives in the fact that someone clicked a checkbox once, with no
 * record of when or against which policy version, is not demonstrable after
 * the fact. Append-only by design: a later consent SUPERSEDES an earlier one
 * (queried by taking the most recent row), it never overwrites it — the
 * history itself is part of what "demonstrable" requires.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

import { forbidden } from "@/lib/errors";
import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import {
  consentTypeEnum,
  userConsents,
  users,
  type ConsentType,
  type UserConsent,
  type UserRole,
} from "@/server/db/schema";
import { insertReturning } from "@/server/db/returning";
import { rows as queryRows } from "@/server/db/raw";

export { CURRENT_POLICY_VERSION };

export async function recordConsent(
  userId: string,
  consentType: ConsentType,
  options: {
    version?: string;
    ipAddress?: string | null;
    granted?: boolean;
  } = {},
): Promise<UserConsent> {
  const [consent] = await insertReturning(db, userConsents, {
    userId,
    consentType,
    version: options.version ?? CURRENT_POLICY_VERSION,
    granted: options.granted ?? true,
    ipAddress: options.ipAddress ?? null,
  });
  return consent;
}

export interface MarketingConsentStatus {
  granted: boolean;
  /** ISO timestamp of the latest grant or withdrawal; null if never chosen. */
  lastChangedAt: string | null;
}

/**
 * Marketing consent (GS-070). Opt-in only: no row, or a withdrawal as the
 * latest row, means no marketing may be sent. A grant made against an older
 * policy version still counts until the user is asked again.
 */
export async function getMarketingConsentStatus(
  userId: string,
): Promise<MarketingConsentStatus> {
  const latest = await getLatestConsent(userId, "MARKETING_COMMUNICATIONS");
  return {
    granted: latest?.granted ?? false,
    lastChangedAt: latest ? latest.createdAt.toISOString() : null,
  };
}

/** Records a grant or a withdrawal as a new row, and audits the change. */
export async function setMarketingConsent(
  userId: string,
  granted: boolean,
  options: { ipAddress?: string | null } = {},
): Promise<UserConsent> {
  const consent = await recordConsent(userId, "MARKETING_COMMUNICATIONS", {
    granted,
    ipAddress: options.ipAddress,
  });
  await recordAudit({
    actorId: userId,
    action: AUDIT_ACTIONS.CONSENT_RECORDED,
    entityType: "user_consent",
    entityId: consent.id,
    newValue: {
      consentType: "MARKETING_COMMUNICATIONS",
      granted,
      version: consent.version,
    },
    ipAddress: options.ipAddress ?? null,
  });
  return consent;
}

export async function getLatestConsent(
  userId: string,
  consentType: ConsentType,
): Promise<UserConsent | undefined> {
  return db.query.userConsents.findFirst({
    where: and(
      eq(userConsents.userId, userId),
      eq(userConsents.consentType, consentType),
    ),
    orderBy: desc(userConsents.createdAt),
  });
}

/**
 * Whether the user's most recent consent is a grant for the CURRENT policy
 * version — not a stale version, and not a withdrawal.
 */
export async function hasCurrentConsent(
  userId: string,
  consentType: ConsentType,
): Promise<boolean> {
  const latest = await getLatestConsent(userId, consentType);
  return latest?.granted === true && latest.version === CURRENT_POLICY_VERSION;
}

export async function listConsentHistory(
  userId: string,
): Promise<UserConsent[]> {
  return db
    .select()
    .from(userConsents)
    .where(eq(userConsents.userId, userId))
    .orderBy(desc(userConsents.createdAt));
}

/* ------------------------------------------------------------------ NAV-019
 * Operations' view of consent.
 *
 * DPDPA §6 makes the Data Fiduciary able to *demonstrate* consent; that is
 * only true if someone other than the data principal can actually read the
 * record. Until now `user_consents` was written on every sign-up and every
 * profile toggle and read back only by the customer's own switch and by
 * marketing's audience filter — nobody in operations could answer "did this
 * person consent, to what, and when".
 *
 * Two deliberate limits:
 *   - `ip_address` is on the row but is NOT surfaced here. It is collected as
 *     evidence of the act of consenting, not as something staff browse; a
 *     lawful request for it can read the table directly.
 *   - Reading one person's trail is audited (CONSENT_HISTORY_VIEWED), the same
 *     treatment as revealing a shop's PAN. The aggregate counts are not —
 *     they identify nobody.
 */

const LIVE_USER = isNull(users.deletedAt);

/**
 * The latest row per (user, consent type) — consent is append-only and a later
 * row supersedes an earlier one, so every question below is about the newest.
 */
// The newest consent row per (user, type). PostgreSQL spelled this
// `DISTINCT ON (user_id, consent_type) ... ORDER BY ..., created_at DESC`,
// which MySQL does not have; ranking inside each group and keeping rank 1 is
// the same thing and works on MySQL 8 and MariaDB alike.
const latestConsentPerUser = sql`
  select user_id, consent_type, granted, version, created_at
    from (
      select uc.user_id, uc.consent_type, uc.granted, uc.version, uc.created_at,
             row_number() over (
               partition by uc.user_id, uc.consent_type
               order by uc.created_at desc
             ) as rn
        from user_consents uc
    ) ranked
   where rn = 1`;

export interface ConsentTypeSummary {
  consentType: ConsentType;
  /** Latest row is a grant for the current policy version. */
  current: number;
  /** Latest row is a grant, but against an older policy version. */
  stale: number;
  /** Latest row is a withdrawal (DPDPA §6(4)). */
  withdrawn: number;
  /** No row of this type at all — never asked, or asked before the record existed. */
  never: number;
}

export interface ConsentOverview {
  policyVersion: string;
  liveUsers: number;
  byType: ConsentTypeSummary[];
}

/** Aggregate consent state across live users. Identifies nobody. */
export async function getConsentOverview(): Promise<ConsentOverview> {
  const [[{ total }], rows] = await Promise.all([
    db
      .select({ total: sql<number>`CAST(count(*) AS SIGNED)` })
      .from(users)
      .where(LIVE_USER),
    // `count(*) filter (where c)` becomes `count(case when c then 1 end)`: CASE
    // yields NULL when the condition is false and COUNT skips NULLs, which is
    // what FILTER did. consent_type needed no cast — it is an enum column, so
    // selecting it already gives the string.
    db.execute(sql`
      select l.consent_type as consent_type,
             CAST(count(case when l.granted and l.version = ${CURRENT_POLICY_VERSION} then 1 end) AS SIGNED) as current,
             CAST(count(case when l.granted and l.version <> ${CURRENT_POLICY_VERSION} then 1 end) AS SIGNED) as stale,
             CAST(count(case when not l.granted then 1 end) AS SIGNED) as withdrawn
        from (${latestConsentPerUser}) l
        join users u on u.id = l.user_id and u.deleted_at is null
       group by l.consent_type`),
  ]);

  const liveUsers = Number(total);
  const seen = new Map<
    string,
    { current: number; stale: number; withdrawn: number }
  >();
  for (const row of queryRows<{
    consent_type: string;
    current: number;
    stale: number;
    withdrawn: number;
  }>(rows)) {
    seen.set(row.consent_type, {
      current: Number(row.current),
      stale: Number(row.stale),
      withdrawn: Number(row.withdrawn),
    });
  }

  return {
    policyVersion: CURRENT_POLICY_VERSION,
    liveUsers,
    // Every consent type is listed, including ones nobody has a row for —
    // "nobody has consented to this yet" is itself the answer to a question.
    byType: consentTypeEnum.enumValues.map((consentType) => {
      const counts = seen.get(consentType) ?? {
        current: 0,
        stale: 0,
        withdrawn: 0,
      };
      const recorded = counts.current + counts.stale + counts.withdrawn;
      return {
        consentType,
        ...counts,
        never: Math.max(0, liveUsers - recorded),
      };
    }),
  };
}

export interface ConsentChange {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string;
  consentType: ConsentType;
  granted: boolean;
  version: string;
  createdAt: Date;
}

export interface ConsentChangeFilters {
  consentType?: ConsentType;
  /** true = grants only, false = withdrawals only, undefined = both. */
  granted?: boolean;
  limit?: number;
}

/** The consent trail, newest first — what a grant or withdrawal looked like and when. */
export async function listConsentChanges(
  filters: ConsentChangeFilters = {},
): Promise<ConsentChange[]> {
  const conditions = [LIVE_USER];
  if (filters.consentType)
    conditions.push(eq(userConsents.consentType, filters.consentType));
  if (filters.granted !== undefined)
    conditions.push(eq(userConsents.granted, filters.granted));

  return db
    .select({
      id: userConsents.id,
      userId: userConsents.userId,
      userName: users.name,
      userEmail: users.email,
      consentType: userConsents.consentType,
      granted: userConsents.granted,
      version: userConsents.version,
      createdAt: userConsents.createdAt,
    })
    .from(userConsents)
    .innerJoin(users, eq(users.id, userConsents.userId))
    .where(and(...conditions))
    .orderBy(desc(userConsents.createdAt))
    .limit(Math.min(filters.limit ?? 100, 500));
}

/**
 * One consent row as operations sees it — deliberately NOT `UserConsent`,
 * which carries `ipAddress`. Projecting the columns here means the IP cannot
 * reach a caller by accident, including a future client component that renders
 * this trail; today's page is a server component and would not ship it, but
 * that is a property of the page, not a guarantee. This is the guarantee.
 */
export interface ConsentTrailEntry {
  id: string;
  consentType: ConsentType;
  granted: boolean;
  version: string;
  createdAt: Date;
}

export interface UserConsentTrail {
  user: { id: string; name: string | null; email: string };
  history: ConsentTrailEntry[];
}

/**
 * One person's full consent trail, for answering a data-principal request.
 *
 * Audited on every call: who looked at whose consent record, and when. An
 * operator or admin may read it; nobody else, including the subject (who sees
 * their own state on their profile instead).
 */
export async function getUserConsentTrail(
  userId: string,
  actor: { id: string; role: UserRole },
): Promise<UserConsentTrail | null> {
  // Gated on the permission, not on a role list, so this and the page it backs
  // cannot drift apart if CONSENT_VIEW is ever granted somewhere else.
  if (!can(actor.role, PERMISSIONS.CONSENT_VIEW)) {
    throw forbidden("You do not have access to the consent record.");
  }

  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), LIVE_USER))
    .limit(1);
  if (!user) return null;

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CONSENT_HISTORY_VIEWED,
    entityType: "user",
    entityId: userId,
  });

  const history = await db
    .select({
      id: userConsents.id,
      consentType: userConsents.consentType,
      granted: userConsents.granted,
      version: userConsents.version,
      createdAt: userConsents.createdAt,
    })
    .from(userConsents)
    .where(eq(userConsents.userId, userId))
    .orderBy(desc(userConsents.createdAt));

  return { user, history };
}
