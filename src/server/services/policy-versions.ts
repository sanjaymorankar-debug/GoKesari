/**
 * Policy versions and re-consent (open-features CONSENT; docs/policy-reconsent-2026-11).
 *
 * DPDP Act 2023 §6 asks that consent be informed and demonstrable. Until this
 * file, `user_consents` recorded the version a user accepted at sign-up, but a
 * user who signed up before a policy changed was never asked again.
 *
 *   - An admin publishes a version of a document (terms, privacy-policy,
 *     seller-terms) with a change summary in English, Hindi and Marathi. A
 *     version that needs acceptance becomes the "required" version; a minor
 *     edit (requiresAcceptance false) asks nobody.
 *   - A signed-in user who has not accepted the required version (or a later
 *     one) of a document that applies to them is "pending" and, while the
 *     flag `policy_reconsent_enabled` is on, sees the re-consent page.
 *   - Accepting writes an append-only `policy_acceptances` row per document
 *     (version, time, channel, IP, user agent) and an audit entry.
 *
 * Who a document applies to: terms and privacy-policy — everyone signed in;
 * seller-terms — users who own a shop.
 *
 * A grant of TERMS_AND_PRIVACY in `user_consents` made after a terms / privacy
 * version was published also counts as accepting it: that is the sign-up
 * record, written before this table existed and still written at sign-up.
 */
import { and, desc, eq, sql } from "drizzle-orm";

import { conflict, forbidden, validationFailed } from "@/lib/errors";
import { POLICY_VERSION_PATTERN, type ClientChannel } from "@/lib/policy-reconsent";
import { db } from "@/server/db";
import {
  POLICY_DOCS,
  policyAcceptances,
  policyVersions,
  type PolicyAcceptanceChannel,
  type PolicyDoc,
  type PolicySummary,
  type PolicyVersion,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const RECONSENT_FLAG = "policy_reconsent_enabled" as const;

/** Documents every signed-in user accepts. */
const EVERYONE_DOCS: readonly PolicyDoc[] = ["terms", "privacy-policy"];

export interface PendingPolicy {
  doc: PolicyDoc;
  version: string;
  summary: PolicySummary;
  publishedAt: string;
}

export interface ReconsentState {
  /** The flag is on. When false nothing below asks anybody. */
  enabled: boolean;
  needsReconsent: boolean;
  pending: PendingPolicy[];
}

interface RequiredRow {
  doc: PolicyDoc;
  version: string;
  summary: PolicySummary;
  published_at: Date | string;
}

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

/**
 * The required version of each document: the newest published row that needs
 * acceptance. A document whose only rows are minor edits has none.
 */
const requiredVersions = sql`
  select distinct on (pv.doc) pv.doc, pv.version, pv.summary, pv.published_at
    from policy_versions pv
   where pv.requires_acceptance and pv.published_at <= now()
   order by pv.doc, pv.published_at desc`;

/** Documents that apply to this user. */
async function docsFor(userId: string): Promise<PolicyDoc[]> {
  const rows = (await db.execute(sql`select exists (select 1 from shops where owner_id = ${userId}) as owns`)) as unknown as {
    owns: boolean;
  }[];
  return rows[0]?.owns ? [...EVERYONE_DOCS, "seller-terms"] : [...EVERYONE_DOCS];
}

/** Required versions this user has not accepted yet (whatever the flag says). */
export async function getPendingPolicies(userId: string): Promise<PendingPolicy[]> {
  const docs = await docsFor(userId);
  const rows = (await db.execute(sql`
    select r.doc, r.version, r.summary, r.published_at
      from (${requiredVersions}) r
     where r.doc in (${sql.join(docs.map((d) => sql`${d}`), sql`, `)})
       and not exists (
             select 1
               from policy_acceptances a
               join policy_versions v on v.doc = a.doc and v.version = a.version
              where a.user_id = ${userId} and a.doc = r.doc and v.published_at >= r.published_at)
       and not (
             r.doc in ('terms', 'privacy-policy')
             and exists (
                   select 1 from user_consents uc
                    where uc.user_id = ${userId} and uc.consent_type = 'TERMS_AND_PRIVACY'
                      and uc.granted and uc.created_at >= r.published_at))
     order by r.doc`)) as unknown as RequiredRow[];
  return rows.map((r) => ({ doc: r.doc, version: r.version, summary: r.summary ?? { en: "" }, publishedAt: iso(r.published_at) }));
}

/** What the site and the app ask: is the flag on, and must this user accept something first? */
export async function getReconsentState(userId: string): Promise<ReconsentState> {
  const enabled = await isFeatureEnabled(RECONSENT_FLAG).catch(() => false);
  if (!enabled) return { enabled: false, needsReconsent: false, pending: [] };
  const pending = await getPendingPolicies(userId);
  return { enabled: true, needsReconsent: pending.length > 0, pending };
}

export interface AcceptInput {
  accept: { doc: PolicyDoc; version: string }[];
  channel: ClientChannel | PolicyAcceptanceChannel;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Records the user's acceptance of the versions they were shown. Every pending
 * document must be in the list, at its required version: a page left open
 * while an admin published a newer version is refused (409) and shows the new
 * one on reload, so nobody "accepts" text they never saw.
 */
export async function acceptPolicies(userId: string, input: AcceptInput): Promise<ReconsentState> {
  const pending = await getPendingPolicies(userId);
  if (pending.length === 0) return getReconsentState(userId);

  const given = new Map(input.accept.map((a) => [a.doc, a.version]));
  const stale = pending.filter((p) => given.get(p.doc) !== p.version);
  if (stale.length > 0) {
    throw conflict("A policy was updated while this page was open. Please reload and read the latest version.", {
      docs: stale.map((p) => p.doc),
    });
  }

  const rows = await db
    .insert(policyAcceptances)
    .values(
      pending.map((p) => ({
        userId,
        doc: p.doc,
        version: p.version,
        channel: input.channel,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
      })),
    )
    .returning();

  for (const row of rows) {
    await recordAudit({
      actorId: userId,
      action: AUDIT_ACTIONS.POLICY_ACCEPTED,
      entityType: "policy_acceptance",
      entityId: row.id,
      newValue: { doc: row.doc, version: row.version, channel: row.channel },
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
    });
  }
  return getReconsentState(userId);
}

/**
 * Records that a user accepted the current version of documents as part of
 * another step (shop registration). Not gated by the flag: the evidence is
 * worth keeping either way, and it stops a new shop owner being asked again
 * the day the flag is switched on.
 */
export async function recordCurrentAcceptances(
  userId: string,
  docs: readonly PolicyDoc[],
  channel: PolicyAcceptanceChannel,
  options: { ipAddress?: string | null } = {},
): Promise<void> {
  const current = await listCurrentVersions();
  const values = docs
    .map((doc) => current.find((c) => c.doc === doc))
    .filter((c): c is CurrentVersion => Boolean(c?.latest))
    .map((c) => ({ userId, doc: c.doc, version: c.latest!.version, channel, ipAddress: options.ipAddress ?? null }));
  if (values.length === 0) return;
  await db.insert(policyAcceptances).values(values);
}

/* ------------------------------------------------------------------ admin */

export interface CurrentVersion {
  doc: PolicyDoc;
  /** The newest published version, minor or not. */
  latest: PolicyVersion | null;
  /** The version users must have accepted; null when none needs acceptance. */
  required: PolicyVersion | null;
}

export async function listCurrentVersions(): Promise<CurrentVersion[]> {
  const rows = await db.select().from(policyVersions).orderBy(desc(policyVersions.publishedAt));
  const now = Date.now();
  return POLICY_DOCS.map((doc) => {
    const ofDoc = rows.filter((r) => r.doc === doc && r.publishedAt.getTime() <= now);
    return { doc, latest: ofDoc[0] ?? null, required: ofDoc.find((r) => r.requiresAcceptance) ?? null };
  });
}

export async function listVersionHistory(doc: PolicyDoc): Promise<PolicyVersion[]> {
  return db.select().from(policyVersions).where(eq(policyVersions.doc, doc)).orderBy(desc(policyVersions.publishedAt));
}

export interface PublishInput {
  doc: PolicyDoc;
  version: string;
  summary: PolicySummary;
  requiresAcceptance: boolean;
  reason: string;
}

/** An admin publishes a new version. Versions only move forward and are never edited. */
export async function publishPolicyVersion(
  actor: { id: string; role: UserRole },
  input: PublishInput,
): Promise<PolicyVersion> {
  if (actor.role !== "ADMIN") throw forbidden("Only an administrator can publish a policy version.");
  const version = input.version.trim();
  if (!POLICY_VERSION_PATTERN.test(version)) {
    throw validationFailed("Use the policy's date as the version, e.g. 2026-12-01.", { fields: { version: "Invalid version" } });
  }
  const summary: PolicySummary = {
    en: input.summary.en.trim(),
    ...(input.summary.hi?.trim() ? { hi: input.summary.hi.trim() } : {}),
    ...(input.summary.mr?.trim() ? { mr: input.summary.mr.trim() } : {}),
  };
  if (!summary.en) throw validationFailed("Write what changed, in English at least.", { fields: { "summary.en": "Required" } });
  if (!input.reason.trim()) throw validationFailed("Give a reason.", { fields: { reason: "Required" } });

  const [existing] = await db
    .select({ id: policyVersions.id })
    .from(policyVersions)
    .where(and(eq(policyVersions.doc, input.doc), eq(policyVersions.version, version)))
    .limit(1);
  if (existing) throw conflict(`Version ${version} of this document is already published.`);
  const [latest] = await db
    .select({ version: policyVersions.version })
    .from(policyVersions)
    .where(eq(policyVersions.doc, input.doc))
    .orderBy(desc(policyVersions.publishedAt))
    .limit(1);
  if (latest && version < latest.version) {
    throw validationFailed(`The new version must be later than ${latest.version}.`, { fields: { version: "Older than the current version" } });
  }

  const [row] = await db
    .insert(policyVersions)
    .values({
      doc: input.doc,
      version,
      summary,
      requiresAcceptance: input.requiresAcceptance,
      publishedBy: actor.id,
      reason: input.reason.trim(),
    })
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.POLICY_VERSION_PUBLISHED,
    entityType: "policy_version",
    entityId: row.id,
    previousValue: latest ? { version: latest.version } : null,
    newValue: { doc: row.doc, version: row.version, requiresAcceptance: row.requiresAcceptance, reason: row.reason },
  });
  return row;
}

export interface VersionAcceptanceCount {
  version: string;
  requiresAcceptance: boolean;
  publishedAt: Date;
  /** Distinct users who accepted this exact version. */
  acceptedBy: number;
  /** Of those, through each channel. */
  byChannel: Record<string, number>;
}

export interface DocAcceptanceReport {
  doc: PolicyDoc;
  required: { version: string; publishedAt: Date } | null;
  /** Live users the document applies to. */
  audience: number;
  /** Of the audience, those who accepted the required version or a later one (sign-up grants included). */
  upToDate: number;
  pending: number;
  versions: VersionAcceptanceCount[];
}

/** Acceptance counts per version for the admin report. Identifies nobody. */
export async function getPolicyAcceptanceReport(): Promise<DocAcceptanceReport[]> {
  const [current, countRows, totals, audienceRows] = await Promise.all([
    listCurrentVersions(),
    db.execute(sql`
      select a.doc, a.version, a.channel, count(distinct a.user_id)::int as users
        from policy_acceptances a
        join users u on u.id = a.user_id and u.deleted_at is null
       group by a.doc, a.version, a.channel`) as unknown as Promise<{ doc: string; version: string; channel: string; users: number }[]>,
    // Distinct users per version (the per-channel counts can hold the same user twice).
    db.execute(sql`
      select a.doc, a.version, count(distinct a.user_id)::int as users
        from policy_acceptances a
        join users u on u.id = a.user_id and u.deleted_at is null
       group by a.doc, a.version`) as unknown as Promise<{ doc: string; version: string; users: number }[]>,
    db.execute(sql`
      select
        (select count(*)::int from users where deleted_at is null) as everyone,
        (select count(distinct s.owner_id)::int from shops s join users u on u.id = s.owner_id and u.deleted_at is null) as owners`) as unknown as Promise<
      { everyone: number; owners: number }[]
    >,
  ]);
  const { everyone, owners } = audienceRows[0] ?? { everyone: 0, owners: 0 };

  const out: DocAcceptanceReport[] = [];
  for (const c of current) {
    const audience = c.doc === "seller-terms" ? Number(owners) : Number(everyone);
    let upToDate = 0;
    if (c.required) {
      const since = c.required.publishedAt.toISOString();
      const audienceFilter =
        c.doc === "seller-terms" ? sql`and exists (select 1 from shops s where s.owner_id = u.id)` : sql``;
      const fallback = (EVERYONE_DOCS as readonly string[]).includes(c.doc)
        ? sql`or exists (select 1 from user_consents uc where uc.user_id = u.id and uc.consent_type = 'TERMS_AND_PRIVACY'
                            and uc.granted and uc.created_at >= ${since}::timestamptz)`
        : sql``;
      const [row] = (await db.execute(sql`
        select count(*)::int as n
          from users u
         where u.deleted_at is null ${audienceFilter}
           and (exists (select 1 from policy_acceptances a
                          join policy_versions v on v.doc = a.doc and v.version = a.version
                         where a.user_id = u.id and a.doc = ${c.doc} and v.published_at >= ${since}::timestamptz)
                ${fallback})`)) as unknown as { n: number }[];
      upToDate = Number(row?.n ?? 0);
    }
    const history = await listVersionHistory(c.doc);
    out.push({
      doc: c.doc,
      required: c.required ? { version: c.required.version, publishedAt: c.required.publishedAt } : null,
      audience,
      upToDate: c.required ? upToDate : audience,
      pending: c.required ? Math.max(0, audience - upToDate) : 0,
      versions: history.map((v) => {
        const mine = countRows.filter((r) => r.doc === c.doc && r.version === v.version);
        const byChannel: Record<string, number> = {};
        for (const r of mine) byChannel[r.channel] = Number(r.users);
        return {
          version: v.version,
          requiresAcceptance: v.requiresAcceptance,
          publishedAt: v.publishedAt,
          acceptedBy: Number(totals.find((t) => t.doc === c.doc && t.version === v.version)?.users ?? 0),
          byChannel,
        };
      }),
    });
  }

  return out;
}
