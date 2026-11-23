/**
 * Dealership & Franchise Platform phase 4 (owner brief 23-Nov-2026; docs/dealer-platform/PHASE_4_BUILDER.md):
 * the admin creates and runs schemes without code.
 *
 *   createScheme      a new scheme (DRAFT) with version 1 — blank terms, or a copy of any version (clone)
 *   saveDraft         edits a DRAFT version, or starts the next version from the current one ("new version")
 *   publishVersion    now, or scheduled (effectiveFrom later → the scheme is SCHEDULED; runScheduledSchemeLaunches
 *                     publishes it when the time comes). The old version is SUPERSEDED: its dealers keep it.
 *   setSchemeStatus   SUSPENDED (no new dealers), PUBLISHED again, EXPIRED, ARCHIVED
 *   deleteDraft       a draft never published
 *   compareVersions   field-by-field differences between two versions
 *
 * Every change needs a reason and is audited. Published terms never change (database trigger). Who may do what:
 * permissions SCHEME_EDIT / SCHEME_PUBLISH (phase 6); until then ADMIN.
 */
import { and, desc, eq, lte, sql } from "drizzle-orm";

import { schemeTermsSchema, SCHEME_CATEGORIES, type SchemeCategory, type SchemeTerms } from "@/lib/dealer-schemes";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import { dealerSchemes, dealerSchemeVersions, type DealerScheme, type DealerSchemeVersion, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export interface SchemeActor {
  id: string;
  role: UserRole;
}

export type SchemeAction = "SCHEME_EDIT" | "SCHEME_PUBLISH" | "SCHEME_STATUS";

/** ADMIN, or a dealership role with DEALER_SCHEME_EDIT (drafts) / DEALER_SCHEME_PUBLISH (publish, status). */
export async function requireSchemePermission(actor: SchemeActor, action: SchemeAction): Promise<void> {
  const { requireDealerPermission } = await import("./staff-access");
  const { PERMISSIONS } = await import("@/server/authz/permissions");
  requireDealerPermission(actor, action === "SCHEME_EDIT" ? PERMISSIONS.DEALER_SCHEME_EDIT : PERMISSIONS.DEALER_SCHEME_PUBLISH, "change dealer schemes");
}

/** What the signed-in staff member may do on the schemes screens. */
export async function schemePermissions(actor: SchemeActor): Promise<{ edit: boolean; publish: boolean }> {
  const ok = async (a: SchemeAction) => requireSchemePermission(actor, a).then(() => true, () => false);
  return { edit: await ok("SCHEME_EDIT"), publish: await ok("SCHEME_PUBLISH") };
}

function reasonOf(reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  if (r.length < 5) throw validationFailed("Give a reason (at least 5 characters); it is kept in the audit log.", { fields: { reason: "Required." } });
  return r.slice(0, 500);
}

function parseTerms(terms: unknown): SchemeTerms {
  const parsed = schemeTermsSchema.safeParse(terms);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".") || "terms"] = issue.message;
    throw validationFailed(`The terms are not complete: ${parsed.error.issues[0]?.message ?? "check the form"}`, { fields });
  }
  return parsed.data;
}

/** Blank terms for a new scheme: free, all India, one 20% one-time commission, scheme calculation. */
export function blankTerms(category: SchemeCategory): SchemeTerms {
  return {
    summary: "Describe the scheme in one or two sentences for applicants.",
    calculation: "SCHEME",
    charge: { kind: "FREE", amountPaise: 0, gstRateBp: 0, gstMode: "EXCLUSIVE", refundable: false },
    validityMonths: 12,
    renewal: { allowed: true, chargePaise: 0, windowDays: 30 },
    geography: category === "FRANCHISE" ? { scope: "ZONE", codes: [] } : { scope: "ALL_INDIA", codes: [] },
    exclusivity: category === "FRANCHISE" ? "SHARED" : "NONE",
    maxDealersPerTerritory: category === "FRANCHISE" ? 2 : null,
    territoryBooking: category === "FRANCHISE",
    teamBuilding: false,
    commissionBudgetBp: null,
    components: [{ id: "registration", label: "Shop registration commission", kind: "ONE_TIME", basis: "SHOP_REGISTRATION_FEE", rateBp: 2000, frequency: "ONCE", shopScope: "OWN", durationMonths: null }],
    benefits: [],
    eligibility: [],
    paymentConditions: [],
    customFields: [],
    eligibilityRules: [],
  };
}

async function schemeOf(schemeId: string, client: DbClient = db): Promise<DealerScheme> {
  const [s] = await client.select().from(dealerSchemes).where(eq(dealerSchemes.id, schemeId));
  if (!s) throw notFound("Scheme");
  return s;
}

async function versionOf(versionId: string, client: DbClient = db): Promise<DealerSchemeVersion> {
  const [v] = await client.select().from(dealerSchemeVersions).where(eq(dealerSchemeVersions.id, versionId));
  if (!v) throw notFound("Scheme version");
  return v;
}

export async function createScheme(
  actor: SchemeActor,
  input: { code: string; name: string; category: SchemeCategory; cloneFromVersionId?: string | null; reason: string },
): Promise<{ scheme: DealerScheme; version: DealerSchemeVersion }> {
  await requireSchemePermission(actor, "SCHEME_EDIT");
  const reason = reasonOf(input.reason);
  const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) throw validationFailed("A code of 2–40 capital letters, digits and _ starting with a letter (e.g. SILVER_PARTNER).", { fields: { code: "Invalid." } });
  const name = input.name.trim().slice(0, 80);
  if (name.length < 3) throw validationFailed("Give the scheme a name.", { fields: { name: "Required." } });
  if (!(SCHEME_CATEGORIES as readonly string[]).includes(input.category)) throw validationFailed("Choose dealership or franchise.");
  const source = input.cloneFromVersionId ? await versionOf(input.cloneFromVersionId) : null;
  const terms = source ? parseTerms(source.terms) : blankTerms(input.category);
  return db.transaction(async (tx) => {
    const [dup] = await tx.select({ id: dealerSchemes.id }).from(dealerSchemes).where(eq(dealerSchemes.code, code));
    if (dup) throw conflict(`A scheme with code ${code} already exists.`);
    const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${dealerSchemes.sortOrder}), 0)::int` }).from(dealerSchemes);
    const [scheme] = await tx.insert(dealerSchemes).values({ code, name, category: input.category, status: "DRAFT", sortOrder: Number(max) + 10, createdBy: actor.id }).returning();
    const [version] = await tx
      .insert(dealerSchemeVersions)
      .values({ schemeId: scheme.id, version: 1, status: "DRAFT", label: source ? `Copy of ${source.label ?? `version ${source.version}`}` : "First draft", terms, changeReason: reason, createdBy: actor.id })
      .returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SCHEME_CREATED, entityType: "dealer_scheme", entityId: scheme.id, newValue: { code, name, category: input.category, clonedFrom: source?.id ?? null, reason } }, tx);
    return { scheme, version };
  });
}

/**
 * Saves terms. With a DRAFT `versionId`: edits it. Without one (or with a published one): starts the next version
 * as a DRAFT, so a published version is never touched. One draft per scheme at a time.
 */
export async function saveDraft(actor: SchemeActor, schemeId: string, input: { versionId?: string | null; terms: unknown; label?: string | null; reason: string }): Promise<DealerSchemeVersion> {
  await requireSchemePermission(actor, "SCHEME_EDIT");
  const reason = reasonOf(input.reason);
  const terms = parseTerms(input.terms);
  const scheme = await schemeOf(schemeId);
  if (scheme.status === "ARCHIVED") throw conflict("An archived scheme cannot be edited. Clone it into a new scheme.");
  return db.transaction(async (tx) => {
    const existing = input.versionId ? await versionOf(input.versionId, tx) : null;
    if (existing && existing.schemeId !== schemeId) throw notFound("Scheme version");
    let row: DealerSchemeVersion;
    if (existing?.status === "DRAFT") {
      [row] = await tx.update(dealerSchemeVersions).set({ terms, label: input.label?.trim().slice(0, 80) || existing.label, changeReason: reason, updatedAt: new Date() }).where(eq(dealerSchemeVersions.id, existing.id)).returning();
    } else {
      const [draft] = await tx.select({ id: dealerSchemeVersions.id, version: dealerSchemeVersions.version }).from(dealerSchemeVersions).where(and(eq(dealerSchemeVersions.schemeId, schemeId), eq(dealerSchemeVersions.status, "DRAFT")));
      if (draft) throw conflict(`Version ${draft.version} is already a draft; edit it instead of starting another.`);
      const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${dealerSchemeVersions.version}), 0)::int` }).from(dealerSchemeVersions).where(eq(dealerSchemeVersions.schemeId, schemeId));
      [row] = await tx.insert(dealerSchemeVersions).values({ schemeId, version: Number(max) + 1, status: "DRAFT", label: input.label?.trim().slice(0, 80) || `Version ${Number(max) + 1}`, terms, changeReason: reason, createdBy: actor.id }).returning();
    }
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SCHEME_VERSION_SAVED, entityType: "dealer_scheme", entityId: schemeId, previousValue: existing ? { versionId: existing.id, termsHash: existing.termsHash } : null, newValue: { versionId: row.id, version: row.version, termsHash: row.termsHash, reason } }, tx);
    return row;
  });
}

/**
 * Publishes a DRAFT version now, or schedules it (effectiveFrom in the future: the scheme shows SCHEDULED and the
 * job publishes it then). The previously published version is SUPERSEDED: dealers on it keep it.
 */
export async function publishVersion(actor: SchemeActor | null, versionId: string, input: { effectiveFrom?: Date | null; reason: string }): Promise<DealerSchemeVersion> {
  if (actor) await requireSchemePermission(actor, "SCHEME_PUBLISH");
  const reason = reasonOf(input.reason);
  const now = new Date();
  const version = await versionOf(versionId);
  if (version.status !== "DRAFT") throw conflict("Only a draft can be published.");
  parseTerms(version.terms);
  const scheme = await schemeOf(version.schemeId);
  if (scheme.status === "ARCHIVED") throw conflict("An archived scheme cannot be published.");
  if (input.effectiveFrom && input.effectiveFrom.getTime() > now.getTime() + 60_000) {
    return db.transaction(async (tx) => {
      const [row] = await tx.update(dealerSchemeVersions).set({ effectiveFrom: input.effectiveFrom!, changeReason: reason, updatedAt: now }).where(eq(dealerSchemeVersions.id, version.id)).returning();
      // A scheme already open stays open on its current version until the launch; a new one shows SCHEDULED.
      await tx.update(dealerSchemes).set({ status: scheme.status === "DRAFT" ? "SCHEDULED" : scheme.status, launchAt: input.effectiveFrom!, updatedAt: now }).where(eq(dealerSchemes.id, scheme.id));
      await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.SCHEME_VERSION_PUBLISHED, entityType: "dealer_scheme", entityId: scheme.id, newValue: { versionId, version: version.version, scheduledFor: input.effectiveFrom!.toISOString(), reason } }, tx);
      return row;
    });
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dealer-scheme:${scheme.id}`}))`);
    const [current] = await tx.select().from(dealerSchemeVersions).where(and(eq(dealerSchemeVersions.schemeId, scheme.id), eq(dealerSchemeVersions.status, "PUBLISHED")));
    if (current) await tx.update(dealerSchemeVersions).set({ status: "SUPERSEDED", updatedAt: now }).where(eq(dealerSchemeVersions.id, current.id));
    const [row] = await tx.update(dealerSchemeVersions).set({ status: "PUBLISHED", publishedAt: now, publishedBy: actor?.id ?? null, effectiveFrom: now, changeReason: reason, updatedAt: now }).where(and(eq(dealerSchemeVersions.id, version.id), eq(dealerSchemeVersions.status, "DRAFT"))).returning();
    if (!row) throw conflict("The version changed; reload and try again.");
    const status = scheme.status === "SUSPENDED" || scheme.status === "EXPIRED" ? scheme.status : "PUBLISHED";
    await tx.update(dealerSchemes).set({ status, launchAt: null, updatedAt: now }).where(eq(dealerSchemes.id, scheme.id));
    await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.SCHEME_VERSION_PUBLISHED, entityType: "dealer_scheme", entityId: scheme.id, previousValue: current ? { versionId: current.id, version: current.version } : null, newValue: { versionId, version: version.version, termsHash: version.termsHash, schemeStatus: status, reason } }, tx);
    return row;
  });
}

const STATUS_MOVES: Record<string, string[]> = {
  SUSPENDED: ["PUBLISHED", "SCHEDULED"],
  PUBLISHED: ["SUSPENDED"],
  EXPIRED: ["PUBLISHED", "SUSPENDED", "SCHEDULED"],
  ARCHIVED: ["DRAFT", "SUSPENDED", "EXPIRED"],
};

/** Suspend (no new dealers; existing ones unaffected), reopen, expire or archive a scheme. */
export async function setSchemeStatus(actor: SchemeActor, schemeId: string, to: "SUSPENDED" | "PUBLISHED" | "EXPIRED" | "ARCHIVED", reason: string): Promise<DealerScheme> {
  await requireSchemePermission(actor, "SCHEME_STATUS");
  const why = reasonOf(reason);
  const scheme = await schemeOf(schemeId);
  if (!STATUS_MOVES[to]?.includes(scheme.status)) throw conflict(`A ${scheme.status.toLowerCase()} scheme cannot become ${to.toLowerCase()}.`);
  if (to === "PUBLISHED") {
    const [pub] = await db.select({ id: dealerSchemeVersions.id }).from(dealerSchemeVersions).where(and(eq(dealerSchemeVersions.schemeId, schemeId), eq(dealerSchemeVersions.status, "PUBLISHED")));
    if (!pub) throw conflict("Publish a version first.");
  }
  if ((to === "ARCHIVED" || to === "EXPIRED") && scheme.code === "FREE") throw conflict("Free Dealership is the default for new dealers and cannot be expired or archived. Suspend it instead.");
  const [row] = await db.update(dealerSchemes).set({ status: to, launchAt: to === "PUBLISHED" ? scheme.launchAt : null, updatedAt: new Date() }).where(eq(dealerSchemes.id, schemeId)).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SCHEME_STATUS_CHANGED, entityType: "dealer_scheme", entityId: schemeId, previousValue: { status: scheme.status }, newValue: { status: to, reason: why } });
  return row;
}

export async function deleteDraft(actor: SchemeActor, versionId: string, reason: string): Promise<void> {
  await requireSchemePermission(actor, "SCHEME_EDIT");
  const why = reasonOf(reason);
  const version = await versionOf(versionId);
  if (version.status !== "DRAFT") throw conflict("Only a draft can be deleted.");
  await db.delete(dealerSchemeVersions).where(eq(dealerSchemeVersions.id, versionId));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SCHEME_VERSION_SAVED, entityType: "dealer_scheme", entityId: version.schemeId, previousValue: { versionId, version: version.version }, newValue: { deleted: true, reason: why } });
}

export interface TermsDifference {
  path: string;
  from: unknown;
  to: unknown;
}

/** Field-by-field differences (components matched by id). */
export function diffTerms(a: SchemeTerms, b: SchemeTerms): TermsDifference[] {
  const out: TermsDifference[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (Array.isArray(x) && Array.isArray(y) && path === "components") {
      const ids = new Set([...x, ...y].map((c) => (c as { id: string }).id));
      for (const id of ids) walk((x as { id: string }[]).find((c) => c.id === id), (y as { id: string }[]).find((c) => c.id === id), `components[${id}]`);
      return;
    }
    if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path, from: x ?? null, to: y ?? null });
  };
  walk(a, b, "");
  return out;
}

export async function compareVersions(aId: string, bId: string): Promise<{ a: { id: string; version: number }; b: { id: string; version: number }; differences: TermsDifference[] }> {
  const [a, b] = [await versionOf(aId), await versionOf(bId)];
  return { a: { id: a.id, version: a.version }, b: { id: b.id, version: b.version }, differences: diffTerms(parseTerms(a.terms), parseTerms(b.terms)) };
}

/** Job (every few minutes): publishes scheduled versions whose time has come. Idempotent. */
export async function runScheduledSchemeLaunches(now: Date = new Date()): Promise<{ published: number }> {
  const due = await db
    .select({ v: dealerSchemeVersions })
    .from(dealerSchemeVersions)
    .innerJoin(dealerSchemes, eq(dealerSchemes.id, dealerSchemeVersions.schemeId))
    .where(and(eq(dealerSchemeVersions.status, "DRAFT"), lte(dealerSchemeVersions.effectiveFrom, now), sql`${dealerSchemes.launchAt} is not null`, sql`${dealerSchemes.status} <> 'ARCHIVED'`))
    .orderBy(desc(dealerSchemeVersions.effectiveFrom));
  let published = 0;
  for (const { v } of due) {
    try {
      await publishVersion(null, v.id, { reason: `scheduled launch (${v.effectiveFrom?.toISOString()})` });
      published += 1;
    } catch (error) {
      console.error("[dealer-schemes] scheduled launch failed", v.id, error);
    }
  }
  return { published };
}
