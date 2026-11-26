/**
 * Legal document registry (docs/seller-agreements-2026-11, brief §1): versioned agreement templates per
 * document type and language, managed by admins — import, upload a new version, preview, publish, retire.
 *
 * Rules:
 * - English is the master. A Marathi / Hindi row of the same version must use exactly the same merge fields
 *   and blocks. It is published with its English version as a draft translation (owner decision 26-Nov-2026:
 *   marked "Draft translation" in the document, English prevails); legal review is recorded when done.
 * - Publishing runs checks (publishChecks): blocking problems stop it; warnings must be acknowledged.
 *   The commission clash between documents (SLA 2 % / medical 3 %) is blocking — the system never picks one.
 * - A new version of a document that already has a published version needs an effective date at least
 *   sellerAgreements.noticeDays ahead; publishing it sends the change notice (e-mail + app) to the owners of
 *   the shops it applies to, and owners re-accept on their next sign-in after the effective date.
 */
import fs from "node:fs";
import path from "node:path";

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  legalDocuments,
  shops,
  type LegalAgreementType,
  type LegalDocumentRow,
  type LegalLanguage,
  type LegalReviewNote,
  type LegalSourceValues,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { commissionRates } from "@/server/db/schema";
import { getRule } from "@/server/services/settings";
import { resolveFeeForNewRegistration } from "@/server/services/registration-fees";

import { localise, sha256Hex } from "./data";
import { buildPartials } from "./partials";
import { renderAgreementHtml } from "./render";
import { sampleSnapshot } from "./sample";
import { DEFAULT_MEDICAL_SHOP_TYPES } from "./snapshot";
import { TemplateSyntaxError, renderTemplate, templateTokens, unsafeTemplateHtml, type TemplateData } from "./template-engine";

export type Actor = { id: string; role: string };

/** The documents an owner signs (Terms and Privacy are accepted through policy_versions, not here). */
export const SIGNED_DOC_TYPES = ["SELLER_SLA", "MEDICAL_ONBOARDING"] as const satisfies readonly LegalAgreementType[];
export type SignedDocType = (typeof SIGNED_DOC_TYPES)[number];

export const DOC_TITLES: Record<SignedDocType, Record<LegalLanguage, string>> = {
  SELLER_SLA: {
    en: "Seller Service Level Agreement",
    mr: "विक्रेता सेवा स्तर करार",
    hi: "विक्रेता सेवा स्तर करार",
  },
  MEDICAL_ONBOARDING: {
    en: "Merchant Onboarding & Authorisation Agreement – Medical Shop",
    mr: "व्यापारी समावेशन व प्राधिकार करार – मेडिकल दुकान",
    hi: "व्यापारी ऑनबोर्डिंग और प्राधिकार करार – मेडिकल शॉप",
  },
};

/* --------------------------------------------------------------- bundled v1.0 */

const TEMPLATE_DIR = path.join(process.cwd(), "src", "server", "legal-agreements", "templates");
const BUNDLED: Record<SignedDocType, { dir: string; appliesTo: string[]; sourceValues: LegalSourceValues; reviewNotes: LegalReviewNote[] }> = {
  SELLER_SLA: {
    dir: "seller-sla",
    appliesTo: [],
    sourceValues: {
      commissionPct: 2,
      settlementDays: 3,
      registrationFeeRupees: 1000,
      wholesaleRegistrationFeeRupees: 2500,
      acceptMinutes: 10,
      slaChargesRupees: { lateReady: 15, sellerCancel: 30, lateThenCancel: 45, defect: 30, medicineBreach: 500 },
    },
    reviewNotes: [],
  },
  MEDICAL_ONBOARDING: {
    dir: "medical-onboarding",
    appliesTo: DEFAULT_MEDICAL_SHOP_TYPES,
    // Owner decision 26-Nov-2026 (option A): 2 % platform commission for every shop, medical shops included.
    // The Word document said 3 %; the template prints the configured rate (Admin → Finance) either way.
    sourceValues: { commissionPct: 2, registrationFeeRupees: 1000 },
    // Owner decision 26-Nov-2026: e-signature + acceptance of terms, no stamp paper / stamp duty (clause 13 rewritten).
    reviewNotes: [],
  },
};

export function bundledTemplate(docType: SignedDocType, lang: LegalLanguage, version = "1.0"): string {
  return fs.readFileSync(path.join(TEMPLATE_DIR, BUNDLED[docType].dir, `v${version}.${lang}.html`), "utf8");
}

/** Imports the bundled v1.0 templates (English DRAFT; Marathi / Hindi DRAFT pending legal review) once. */
export async function ensureBundledTemplates(actorId: string | null = null): Promise<number> {
  let inserted = 0;
  for (const docType of SIGNED_DOC_TYPES) {
    const [existing] = await db.select({ id: legalDocuments.id }).from(legalDocuments).where(eq(legalDocuments.docType, docType)).limit(1);
    if (existing) continue;
    const meta = BUNDLED[docType];
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    for (const lang of ["en", "mr", "hi"] as const) {
      const body = bundledTemplate(docType, lang);
      const rows = await db
        .insert(legalDocuments)
        .values({
          docType,
          language: lang,
          version: "1.0",
          effectiveDate: today,
          title: DOC_TITLES[docType][lang],
          appliesToShopTypes: meta.appliesTo,
          templateBody: body,
          templateSha256: sha256Hex(body),
          sourceValues: meta.sourceValues,
          reviewStatus: lang === "en" ? "NOT_REQUIRED" : "PENDING_LEGAL_REVIEW",
          reviewNotes: lang === "en" ? meta.reviewNotes : [],
          changeSummary: lang === "en" ? "First version, imported from the owner's Word document (25-Nov-2026)." : "Draft translation – pending legal review.",
          requiresResign: true,
          createdBy: actorId,
        })
        .onConflictDoNothing()
        .returning({ id: legalDocuments.id });
      inserted += rows.length;
    }
  }
  return inserted;
}

/* --------------------------------------------------------------- reading */

export async function listTemplates(): Promise<LegalDocumentRow[]> {
  return db.select().from(legalDocuments).orderBy(legalDocuments.docType, desc(legalDocuments.createdAt), legalDocuments.language);
}

export async function getTemplate(id: string): Promise<LegalDocumentRow> {
  const [row] = await db.select().from(legalDocuments).where(eq(legalDocuments.id, id)).limit(1);
  if (!row) throw notFound("Agreement template");
  return row;
}

const todayIst = (at = new Date()) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);

export function appliesToShopType(row: Pick<LegalDocumentRow, "appliesToShopTypes">, shopType: string): boolean {
  return row.appliesToShopTypes.length === 0 || row.appliesToShopTypes.includes(shopType);
}

export type CurrentDocument = {
  docType: SignedDocType;
  version: string;
  english: LegalDocumentRow;
  /** Published rows of the same version, by language (English always present). */
  languages: Partial<Record<LegalLanguage, LegalDocumentRow>>;
};

/**
 * The versions a shop of this type must have signed now: per document type, the newest published English
 * version whose effective date has come, plus its published translations.
 */
export async function currentDocumentsFor(shopType: string, at: Date = new Date()): Promise<CurrentDocument[]> {
  const today = todayIst(at);
  const rows = await db
    .select()
    .from(legalDocuments)
    .where(and(eq(legalDocuments.status, "PUBLISHED"), inArray(legalDocuments.docType, [...SIGNED_DOC_TYPES]), sql`${legalDocuments.effectiveDate} <= ${today}`))
    .orderBy(desc(legalDocuments.effectiveDate), desc(legalDocuments.publishedAt));
  const out: CurrentDocument[] = [];
  for (const docType of SIGNED_DOC_TYPES) {
    const english = rows.find((r) => r.docType === docType && r.language === "en" && appliesToShopType(r, shopType));
    if (!english) continue;
    const languages: CurrentDocument["languages"] = { en: english };
    for (const r of rows) if (r.docType === docType && r.version === english.version && r.language !== "en") languages[r.language] ??= r;
    out.push({ docType, version: english.version, english, languages });
  }
  return out;
}

/* --------------------------------------------------------------- validation */

function flattenKeys(data: TemplateData, prefix = ""): string[] {
  return Object.entries(data).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? flattenKeys(v as TemplateData, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

/** Every merge field and block a template may use. */
export function allowedTokens(): { fields: Set<string>; partials: Set<string> } {
  const s = sampleSnapshot();
  const data = localise(s, "en", new Date(), { signed: false });
  return { fields: new Set(flattenKeys(data)), partials: new Set(Object.keys(buildPartials(s, "en", { signed: false }))) };
}

/** Problems with a template body itself (unsafe HTML, syntax, unknown fields / blocks). */
export function templateProblems(body: string): string[] {
  const problems = unsafeTemplateHtml(body).map((p) => `The template ${p}.`);
  let tokens: ReturnType<typeof templateTokens>;
  try {
    tokens = templateTokens(body);
  } catch (error) {
    return [...problems, error instanceof TemplateSyntaxError ? error.message : "The template could not be read."];
  }
  const allowed = allowedTokens();
  for (const f of [...tokens.fields, ...tokens.conditions]) if (!allowed.fields.has(f)) problems.push(`Unknown merge field {{${f}}}.`);
  for (const p of tokens.partials) if (!allowed.partials.has(p)) problems.push(`Unknown block {{> ${p}}}.`);
  if (body.length > 400_000) problems.push("The template is too long (400 kB at most).");
  return problems;
}

/** A translation must carry exactly the English version's merge fields and blocks. */
export function translationMismatch(english: string, translated: string): string[] {
  const count = (body: string) => {
    const m = new Map<string, number>();
    for (const t of body.match(/\{\{[^}]*\}\}/g) ?? []) m.set(t.replace(/\s+/g, ""), (m.get(t.replace(/\s+/g, "")) ?? 0) + 1);
    return m;
  };
  const a = count(english);
  const b = count(translated);
  const problems: string[] = [];
  for (const [t, n] of a) if ((b.get(t) ?? 0) !== n) problems.push(`${t} appears ${b.get(t) ?? 0} time(s) in the translation, ${n} in English.`);
  for (const [t] of b) if (!a.has(t)) problems.push(`${t} is in the translation but not in English.`);
  return problems;
}

/* --------------------------------------------------------------- writing */

export type TemplateInput = {
  docType: SignedDocType;
  language: LegalLanguage;
  version: string;
  effectiveDate: string;
  title?: string;
  templateBody: string;
  appliesToShopTypes?: string[];
  sourceValues?: LegalSourceValues;
  changeSummary?: string | null;
  requiresResign?: boolean;
};

const VERSION_RE = /^\d{1,3}\.\d{1,3}$/;

export async function createTemplateVersion(input: TemplateInput, actor: Actor): Promise<LegalDocumentRow> {
  if (!VERSION_RE.test(input.version)) throw validationFailed("Version must look like 1.0, 1.1 or 2.0.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate)) throw validationFailed("Effective date must be a date (YYYY-MM-DD).");
  const problems = templateProblems(input.templateBody);
  if (input.language !== "en") {
    const [english] = await db
      .select()
      .from(legalDocuments)
      .where(and(eq(legalDocuments.docType, input.docType), eq(legalDocuments.language, "en"), eq(legalDocuments.version, input.version)))
      .limit(1);
    if (!english) throw validationFailed(`Upload the English version ${input.version} first; translations follow the English master.`);
    problems.push(...translationMismatch(english.templateBody, input.templateBody));
    if (!/English version shall prevail/i.test(input.templateBody)) {
      problems.push('A translation must say "In case of any difference between language versions, the English version shall prevail."');
    }
  }
  if (problems.length) throw validationFailed(problems.join(" "), { problems });
  try {
    const [row] = await db
      .insert(legalDocuments)
      .values({
        docType: input.docType,
        language: input.language,
        version: input.version,
        effectiveDate: input.effectiveDate,
        title: input.title?.trim() || DOC_TITLES[input.docType][input.language],
        templateBody: input.templateBody,
        templateSha256: sha256Hex(input.templateBody),
        appliesToShopTypes: input.appliesToShopTypes ?? BUNDLED[input.docType].appliesTo,
        sourceValues: input.sourceValues ?? {},
        reviewStatus: input.language === "en" ? "NOT_REQUIRED" : "PENDING_LEGAL_REVIEW",
        changeSummary: input.changeSummary ?? null,
        requiresResign: input.requiresResign ?? true,
        createdBy: actor.id,
      })
      .returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role as never, action: AUDIT_ACTIONS.AGREEMENT_TEMPLATE_SAVED, entityType: "legal_document", entityId: row.id, newValue: { docType: row.docType, language: row.language, version: row.version } });
    return row;
  } catch (error) {
    if (String((error as { code?: string }).code) === "23505") throw conflict(`Version ${input.version} (${input.language}) of this document already exists.`);
    throw error;
  }
}

export type DraftPatch = Partial<Pick<TemplateInput, "effectiveDate" | "title" | "templateBody" | "appliesToShopTypes" | "sourceValues" | "changeSummary" | "requiresResign">>;

export async function updateDraft(id: string, patch: DraftPatch, actor: Actor): Promise<LegalDocumentRow> {
  const row = await getTemplate(id);
  if (row.status !== "DRAFT") throw conflict("Only a draft can be edited. Upload a new version instead.");
  if (patch.templateBody !== undefined) {
    const problems = templateProblems(patch.templateBody);
    if (row.language !== "en") {
      const [english] = await db.select().from(legalDocuments).where(and(eq(legalDocuments.docType, row.docType), eq(legalDocuments.language, "en"), eq(legalDocuments.version, row.version))).limit(1);
      if (english) problems.push(...translationMismatch(english.templateBody, patch.templateBody));
    }
    if (problems.length) throw validationFailed(problems.join(" "), { problems });
  }
  const [updated] = await db
    .update(legalDocuments)
    .set({
      ...(patch.effectiveDate ? { effectiveDate: patch.effectiveDate } : {}),
      ...(patch.title ? { title: patch.title.trim() } : {}),
      ...(patch.templateBody !== undefined ? { templateBody: patch.templateBody, templateSha256: sha256Hex(patch.templateBody) } : {}),
      ...(patch.appliesToShopTypes ? { appliesToShopTypes: patch.appliesToShopTypes } : {}),
      ...(patch.sourceValues ? { sourceValues: patch.sourceValues } : {}),
      ...(patch.changeSummary !== undefined ? { changeSummary: patch.changeSummary } : {}),
      ...(patch.requiresResign !== undefined ? { requiresResign: patch.requiresResign } : {}),
      // An edited translation must be reviewed again.
      ...(patch.templateBody !== undefined && row.language !== "en" ? { reviewStatus: "PENDING_LEGAL_REVIEW" as const, reviewedAt: null, reviewedBy: null } : {}),
    })
    .where(and(eq(legalDocuments.id, id), eq(legalDocuments.status, "DRAFT")))
    .returning();
  if (!updated) throw conflict("This draft was published or retired meanwhile.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role as never, action: AUDIT_ACTIONS.AGREEMENT_TEMPLATE_SAVED, entityType: "legal_document", entityId: id, newValue: { fields: Object.keys(patch) } });
  return updated;
}

/** The admin confirms a lawyer reviewed a translation ("translation") or a flagged clause (its note key). */
export async function confirmReview(id: string, what: string, actor: Actor): Promise<LegalDocumentRow> {
  const row = await getTemplate(id);
  if (row.status !== "DRAFT") throw conflict("Only a draft can be reviewed.");
  const now = new Date();
  let set: Partial<typeof legalDocuments.$inferInsert>;
  if (what === "translation") {
    if (row.language === "en") throw validationFailed("The English master needs no translation review.");
    set = { reviewStatus: "REVIEWED", reviewedAt: now, reviewedBy: actor.id };
  } else {
    const notes = row.reviewNotes.map((n) => (n.key === what ? { ...n, confirmedBy: actor.id, confirmedAt: now.toISOString() } : n));
    if (!row.reviewNotes.some((n) => n.key === what)) throw notFound("Review note");
    set = { reviewNotes: notes };
  }
  const [updated] = await db.update(legalDocuments).set(set).where(eq(legalDocuments.id, id)).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role as never, action: AUDIT_ACTIONS.AGREEMENT_TEMPLATE_REVIEWED, entityType: "legal_document", entityId: id, newValue: { reviewed: what } });
  return updated;
}

/* --------------------------------------------------------------- publishing */

export type PublishCheck = { blocking: string[]; warnings: string[] };

async function configuredCommissionPct(shopTypes: string[]): Promise<{ label: string; pct: number }[]> {
  const rates = await db.select().from(commissionRates).where(eq(commissionRates.isActive, true));
  const fallback = rates.find((r) => r.scope === "DEFAULT");
  const pct = (bp: number | undefined) => (bp ?? 0) / 100;
  if (shopTypes.length === 0) {
    return [{ label: "default rate", pct: pct(fallback?.rateBp) }];
  }
  return shopTypes.map((t) => {
    const r = rates.find((x) => x.scope === "SHOP_TYPE" && x.shopType === t) ?? fallback;
    return { label: `${t} shops`, pct: pct(r?.rateBp) };
  });
}

export async function publishChecks(id: string): Promise<PublishCheck> {
  const row = await getTemplate(id);
  const blocking: string[] = [];
  const warnings: string[] = [];
  if (row.status !== "DRAFT") blocking.push(`This version is ${row.status.toLowerCase()}, not a draft.`);
  blocking.push(...templateProblems(row.templateBody));

  // Fill the template with the live configuration (sample shop) — nothing may be left blank.
  const [rule, settlement, fee] = await Promise.all([getRule("sellerAgreements"), getRule("settlement"), resolveFeeForNewRegistration()]);
  const sample = sampleSnapshot({
    platform: {
      signatoryName: rule.platformSignatoryName,
      signatoryDesignation: rule.platformSignatoryDesignation,
      boardResolutionDate: rule.boardResolutionDate || null,
      eSealAssetId: rule.eSealAssetId || null,
    },
  });
  try {
    const rendered = renderAgreementHtml(row, sample, { effectiveAt: new Date(), signature: { signed: false }, preview: true });
    for (const m of rendered.missing) {
      blocking.push(`The merge field {{${m}}} would be empty.`);
    }
  } catch (error) {
    blocking.push(error instanceof Error ? error.message : "The template could not be rendered.");
  }
  if (!rule.eSealAssetId) warnings.push("No company e-seal image is uploaded yet: signed copies will show the Platform signature block without a seal.");

  for (const note of row.reviewNotes) {
    if (!note.confirmedAt) blocking.push(`Legal review pending: ${note.text} Confirm the review on this version before publishing.`);
  }

  if (row.language !== "en") {
    // Owner decision 26-Nov-2026: Marathi / Hindi are published as draft translations (marked so in the document,
    // English prevails); the legal review is a warning, not a block.
    if (row.reviewStatus !== "REVIEWED") warnings.push("Draft translation: not yet legally reviewed. It is published marked as a draft translation (English prevails). Mark it reviewed once a lawyer has checked it.");
    const [english] = await db
      .select()
      .from(legalDocuments)
      .where(and(eq(legalDocuments.docType, row.docType), eq(legalDocuments.language, "en"), eq(legalDocuments.version, row.version)))
      .limit(1);
    if (!english) blocking.push("There is no English master of this version.");
    else {
      if (english.status !== "PUBLISHED") blocking.push("Publish the English version of this version first.");
      blocking.push(...translationMismatch(english.templateBody, row.templateBody));
    }
    return { blocking, warnings };
  }

  // Commission stated by the documents (brief: SLA 2 %, medical 3 % — never pick one).
  const others = await db
    .select()
    .from(legalDocuments)
    .where(and(eq(legalDocuments.language, "en"), ne(legalDocuments.docType, row.docType), ne(legalDocuments.status, "RETIRED")))
    .orderBy(desc(legalDocuments.createdAt));
  const mine = row.sourceValues.commissionPct;
  const seen = new Set<string>();
  for (const other of others) {
    if (seen.has(other.docType)) continue;
    seen.add(other.docType);
    const overlap = row.appliesToShopTypes.length === 0 || other.appliesToShopTypes.length === 0 || row.appliesToShopTypes.some((t) => other.appliesToShopTypes.includes(t));
    const theirs = other.sourceValues.commissionPct;
    if (overlap && mine !== undefined && theirs !== undefined && mine !== theirs) {
      blocking.push(
        `Commission clash: this ${row.docType} v${row.version} states ${mine}% but ${other.docType} v${other.version} states ${theirs}%, and a shop can sign both. Decide the commission, then set the same figure in both documents' "stated commission" (and in Admin → Finance) before publishing.`,
      );
    }
  }
  if (mine !== undefined) {
    for (const c of await configuredCommissionPct(row.appliesToShopTypes)) {
      if (c.pct !== mine) warnings.push(`The document states ${mine}% commission; the configured ${c.label} is ${c.pct}%. Agreements print the configured rate.`);
    }
  }
  const sv = row.sourceValues;
  if (sv.settlementDays !== undefined && sv.settlementDays !== settlement.holdDays) {
    warnings.push(`The document states settlement within ${sv.settlementDays} business days; settlement.holdDays is ${settlement.holdDays}. Agreements print the configured value.`);
  }
  if (sv.registrationFeeRupees !== undefined && sv.registrationFeeRupees * 100 !== fee.amountPaise) {
    warnings.push(`The document states a ₹${sv.registrationFeeRupees} registration fee; the configured fee is ₹${fee.amountPaise / 100}. Agreements print the configured fee.`);
  }
  if (sv.wholesaleRegistrationFeeRupees !== undefined && sv.wholesaleRegistrationFeeRupees * 100 !== rule.wholesaleRegistrationFeePaise) {
    warnings.push(`The document states a ₹${sv.wholesaleRegistrationFeeRupees} wholesale fee; the configured one is ₹${rule.wholesaleRegistrationFeePaise / 100}.`);
  }
  for (const [k, v] of Object.entries(sv.slaChargesRupees ?? {})) {
    const configured = rule.slaChargesPaise[k as keyof typeof rule.slaChargesPaise];
    if (configured !== undefined && v * 100 !== configured) warnings.push(`SLA charge "${k}": the document states ₹${v}, configured ₹${configured / 100}.`);
  }

  // A later version needs the change notice period.
  const [previous] = await db
    .select({ id: legalDocuments.id })
    .from(legalDocuments)
    .where(and(eq(legalDocuments.docType, row.docType), eq(legalDocuments.language, "en"), eq(legalDocuments.status, "PUBLISHED")))
    .limit(1);
  if (previous) {
    const earliest = todayIst(new Date(Date.now() + rule.noticeDays * 86_400_000));
    if (row.effectiveDate < earliest) {
      blocking.push(`A new version must take effect at least ${rule.noticeDays} days after it is published (the change notice). Set the effective date to ${earliest} or later.`);
    }
  }
  return { blocking, warnings };
}

export async function publishTemplate(id: string, actor: Actor, options: { acknowledgeWarnings: boolean }): Promise<{ row: LegalDocumentRow; noticeShops: number }> {
  const checks = await publishChecks(id);
  if (checks.blocking.length) throw validationFailed(checks.blocking.join(" "), { checks });
  if (checks.warnings.length && !options.acknowledgeWarnings) throw validationFailed("Read and acknowledge the warnings before publishing.", { checks });
  const [row] = await db
    .update(legalDocuments)
    .set({ status: "PUBLISHED", publishedAt: new Date(), publishedBy: actor.id })
    .where(and(eq(legalDocuments.id, id), eq(legalDocuments.status, "DRAFT")))
    .returning();
  if (!row) throw conflict("This draft was published or retired meanwhile.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role as never,
    action: AUDIT_ACTIONS.AGREEMENT_TEMPLATE_PUBLISHED,
    entityType: "legal_document",
    entityId: id,
    newValue: { docType: row.docType, language: row.language, version: row.version, effectiveDate: row.effectiveDate, warningsAcknowledged: checks.warnings },
  });
  let noticeShops = 0;
  if (row.language === "en") {
    // The Marathi / Hindi drafts of this version go out with it (owner decision 26-Nov-2026), when nothing blocks them.
    const translations = await db
      .select({ id: legalDocuments.id })
      .from(legalDocuments)
      .where(and(eq(legalDocuments.docType, row.docType), eq(legalDocuments.version, row.version), ne(legalDocuments.language, "en"), eq(legalDocuments.status, "DRAFT")));
    for (const t of translations) {
      const tc = await publishChecks(t.id);
      if (tc.blocking.length) continue;
      await db
        .update(legalDocuments)
        .set({ status: "PUBLISHED", publishedAt: new Date(), publishedBy: actor.id })
        .where(and(eq(legalDocuments.id, t.id), eq(legalDocuments.status, "DRAFT")));
      await recordAudit({ actorId: actor.id, actorRole: actor.role as never, action: AUDIT_ACTIONS.AGREEMENT_TEMPLATE_PUBLISHED, entityType: "legal_document", entityId: t.id, newValue: { withEnglish: id, draftTranslation: true, warnings: tc.warnings } });
    }
    const { sendChangeNotices } = await import("./notices");
    noticeShops = await sendChangeNotices(row);
  }
  return { row, noticeShops };
}

export async function retireTemplate(id: string, actor: Actor): Promise<LegalDocumentRow> {
  const [row] = await db
    .update(legalDocuments)
    .set({ status: "RETIRED", retiredAt: new Date(), retiredBy: actor.id })
    .where(and(eq(legalDocuments.id, id), ne(legalDocuments.status, "RETIRED")))
    .returning();
  if (!row) throw conflict("This version is already retired.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role as never, action: AUDIT_ACTIONS.AGREEMENT_TEMPLATE_RETIRED, entityType: "legal_document", entityId: id, newValue: { docType: row.docType, language: row.language, version: row.version } });
  return row;
}

/** Live shops a document version applies to (for the change notice and the pending count). */
export async function shopsForTypes(shopTypes: string[]): Promise<{ id: string; ownerId: string; name: string; pincode: string }[]> {
  return db
    .select({ id: shops.id, ownerId: shops.ownerId, name: shops.name, pincode: shops.pincode })
    .from(shops)
    .where(and(isNull(shops.deletedAt), eq(shops.status, "APPROVED"), shopTypes.length ? inArray(shops.shopType, shopTypes) : undefined));
}

/** Renders a template against the sample shop (admin preview), unsigned. */
export async function previewTemplateHtml(id: string): Promise<{ html: string; missing: string[] }> {
  const row = await getTemplate(id);
  const rule = await getRule("sellerAgreements");
  const sample = sampleSnapshot({
    platform: { signatoryName: rule.platformSignatoryName, signatoryDesignation: rule.platformSignatoryDesignation, boardResolutionDate: rule.boardResolutionDate || null, eSealAssetId: null },
  });
  const rendered = renderAgreementHtml(row, sample, { effectiveAt: new Date(), signature: { signed: false }, preview: true });
  return { html: rendered.html, missing: rendered.missing };
}

export { renderTemplate };
