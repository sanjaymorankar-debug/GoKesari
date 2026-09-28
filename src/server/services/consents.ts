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
import { and, desc, eq } from "drizzle-orm";

import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";
import { db } from "@/server/db";
import { userConsents, type ConsentType, type UserConsent } from "@/server/db/schema";

export { CURRENT_POLICY_VERSION };

export async function recordConsent(
  userId: string,
  consentType: ConsentType,
  options: { version?: string; ipAddress?: string | null; granted?: boolean } = {},
): Promise<UserConsent> {
  const [consent] = await db
    .insert(userConsents)
    .values({
      userId,
      consentType,
      version: options.version ?? CURRENT_POLICY_VERSION,
      granted: options.granted ?? true,
      ipAddress: options.ipAddress ?? null,
    })
    .returning();
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
export async function getMarketingConsentStatus(userId: string): Promise<MarketingConsentStatus> {
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
    newValue: { consentType: "MARKETING_COMMUNICATIONS", granted, version: consent.version },
    ipAddress: options.ipAddress ?? null,
  });
  return consent;
}

export async function getLatestConsent(
  userId: string,
  consentType: ConsentType,
): Promise<UserConsent | undefined> {
  return db.query.userConsents.findFirst({
    where: and(eq(userConsents.userId, userId), eq(userConsents.consentType, consentType)),
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

export async function listConsentHistory(userId: string): Promise<UserConsent[]> {
  return db
    .select()
    .from(userConsents)
    .where(eq(userConsents.userId, userId))
    .orderBy(desc(userConsents.createdAt));
}
