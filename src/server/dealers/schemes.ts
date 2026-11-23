/**
 * Dealership & Franchise Platform phase 1 (owner brief 23-Nov-2026; docs/dealer-platform/): reading schemes,
 * their versions and each dealer's scheme. Writes happen in the database in this phase (migration 0177: seed,
 * new-dealer and franchise-payment triggers); the scheme builder (phase 4) adds the admin's own writes.
 */
import { asc, desc, eq, inArray, sql } from "drizzle-orm";

import { schemeTermsSchema, type SchemeTerms } from "@/lib/dealer-schemes";
import { db, type DbClient } from "@/server/db";
import { dealerSchemeAssignments, dealerSchemes, dealerSchemeVersions, type DealerScheme, type DealerSchemeVersion } from "@/server/db/schema";

export interface SchemeVersionView {
  id: string;
  version: number;
  status: DealerSchemeVersion["status"];
  label: string | null;
  terms: SchemeTerms;
  termsHash: string;
  changeReason: string | null;
  publishedAt: string | null;
  createdAt: string;
  /** Dealers on this version now. */
  activeDealers: number;
}

export interface SchemeView {
  id: string;
  code: string;
  name: string;
  category: DealerScheme["category"];
  status: DealerScheme["status"];
  /** The version offered to new dealers (null while none is published). */
  current: SchemeVersionView | null;
  versions: SchemeVersionView[];
  activeDealers: number;
}

/** Every scheme with all its versions, in display order (admin). */
export async function listSchemes(client: DbClient = db): Promise<SchemeView[]> {
  const schemes = await client.select().from(dealerSchemes).orderBy(asc(dealerSchemes.sortOrder), asc(dealerSchemes.name));
  if (!schemes.length) return [];
  const versions = await client
    .select()
    .from(dealerSchemeVersions)
    .where(inArray(dealerSchemeVersions.schemeId, schemes.map((s) => s.id)))
    .orderBy(desc(dealerSchemeVersions.version));
  const counts = await client
    .select({ versionId: dealerSchemeAssignments.versionId, n: sql<number>`count(*)::int` })
    .from(dealerSchemeAssignments)
    .where(eq(dealerSchemeAssignments.status, "ACTIVE"))
    .groupBy(dealerSchemeAssignments.versionId);
  const countOf = new Map(counts.map((c) => [c.versionId, c.n]));
  return schemes.map((s) => {
    const vs = versions.filter((v) => v.schemeId === s.id).map((v) => versionView(v, countOf.get(v.id) ?? 0));
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      category: s.category,
      status: s.status,
      current: vs.find((v) => v.status === "PUBLISHED") ?? null,
      versions: vs,
      activeDealers: vs.reduce((n, v) => n + v.activeDealers, 0),
    };
  });
}

export interface DealerSchemeView {
  assignmentId: string;
  schemeCode: string;
  schemeName: string;
  category: DealerScheme["category"];
  version: number;
  versionLabel: string | null;
  /** The terms he is on (his copy, never later edits). */
  terms: SchemeTerms;
  termsHash: string;
  source: (typeof dealerSchemeAssignments.$inferSelect)["source"];
  startsAt: string;
  endsAt: string | null;
  endReason: string | null;
  status: (typeof dealerSchemeAssignments.$inferSelect)["status"];
  reason: string | null;
}

/** A dealer's scheme now and before, newest first. */
export async function dealerSchemeHistory(dealerId: string, client: DbClient = db): Promise<DealerSchemeView[]> {
  const rows = await client
    .select({ a: dealerSchemeAssignments, s: dealerSchemes, v: dealerSchemeVersions })
    .from(dealerSchemeAssignments)
    .innerJoin(dealerSchemes, eq(dealerSchemes.id, dealerSchemeAssignments.schemeId))
    .innerJoin(dealerSchemeVersions, eq(dealerSchemeVersions.id, dealerSchemeAssignments.versionId))
    .where(eq(dealerSchemeAssignments.dealerId, dealerId))
    .orderBy(desc(dealerSchemeAssignments.startsAt), desc(dealerSchemeAssignments.createdAt));
  return rows.map(({ a, s, v }) => ({
    assignmentId: a.id,
    schemeCode: s.code,
    schemeName: s.name,
    category: s.category,
    version: v.version,
    versionLabel: v.label,
    terms: a.acceptedTerms,
    termsHash: a.termsHash,
    source: a.source,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt?.toISOString() ?? null,
    endReason: a.endReason,
    status: a.status,
    reason: a.reason,
  }));
}

/** The dealer's current scheme, or null (GoKesari Direct, or a dealer from before the schemes existed). */
export async function currentDealerScheme(dealerId: string, client: DbClient = db): Promise<DealerSchemeView | null> {
  return (await dealerSchemeHistory(dealerId, client)).find((h) => h.status === "ACTIVE") ?? null;
}

/** Stored terms are checked on read too, so a bad row shows up as an error, not as wrong money later. */
function versionView(v: DealerSchemeVersion, activeDealers: number): SchemeVersionView {
  const parsed = schemeTermsSchema.safeParse(v.terms);
  if (!parsed.success) throw new Error(`dealer_scheme_versions ${v.id}: stored terms are invalid: ${parsed.error.issues[0]?.message}`);
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    label: v.label,
    terms: parsed.data,
    termsHash: v.termsHash,
    changeReason: v.changeReason,
    publishedAt: v.publishedAt?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(),
    activeDealers,
  };
}
