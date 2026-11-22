/**
 * Shop document rules (owner, 22-Nov-2026, DF-09; migration 0163).
 *
 * "All these licences and legal documents: give admin access to make it mandatory or optional; admin
 * should have access to add additional documents as and when required as per law."
 *
 * One table of rules decides, for every document a shop may hold (Shop Act, Udyam, FSSAI, the
 * licences, and documents an admin added), whether a shop of a given type needs it:
 *   MUST_HAVE — on file before the registration fee is paid; the shop cannot go live without it
 *               (an admin's "Approve without documents" is the one exception);
 *   PROMISE   — the shop goes live once the owner promises to upload it within promiseDays; the
 *               1st / 15th follow-up reminds them and suspends the shop after the due date;
 *   OPTIONAL  — offered as an upload, never asked for, never chased.
 * A rule's scope is every shop (ALL), every shop that sells food (FOOD), every doctor — a shop in a
 * Health doctor category (DOCTOR, owner 22-Nov-2026, H-52) — or one shop type; the most specific one
 * wins (src/lib/shop-document-rules.ts pickRule). No rule: the document is not asked.
 *
 * GSTIN or PAN is not here: it stays a must-have for every shop (DF-08).
 *
 * A shop already live when an admin makes a document needed is not suspended for it before the rule's
 * live_shops_due_at (now + the days the admin gives, 90 by default).
 *
 * Only an admin changes the rules; operators see them. Every change is audited.
 */
import { and, asc, eq, sql, type SQL } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { DOCTOR_GROUP_NAMES } from "@/lib/health/specialties";
import {
  BUILT_IN_RULE_DOCUMENTS,
  customDocKeyFromLabel,
  isBuiltInRuleDocKey,
  isCustomDocKey,
  isRuleScope,
  pickRule,
  scopeLabel,
  scopeShopType,
  type DocumentLevel,
  type RuleDocumentKind,
} from "@/lib/shop-document-rules";
import { mandatoryLicenceFor } from "@/lib/shop-licences";
import { db, type DbClient } from "@/server/db";
import {
  sellerVerifications,
  shopDocumentRules,
  shopDocumentTypes,
  shopLegalDocuments,
  shops,
  type Shop,
  type ShopDocumentRule,
  type ShopDocumentType,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";
import { listShopTypes } from "./shop-types";

interface Actor {
  id: string;
  role: UserRole;
}

const DAY_MS = 86_400_000;

export interface DocumentRuleSet {
  rules: ShopDocumentRule[];
  /** Admin-added documents still in use (ACTIVE). */
  types: ShopDocumentType[];
  /** documentUpload.fssaiMandatoryForFood: off turns an FSSAI must-have into a promise. */
  fssaiMustHaveSwitch: boolean;
}

export interface ShopDocumentRequirement {
  /** A built-in key (SHOP_ACT, FSSAI, DRUG_LICENCE …) or an admin-added `DOC:…` key. */
  key: string;
  label: string;
  kind: RuleDocumentKind;
  level: DocumentLevel;
  /** Shops already live when this was made needed are not suspended for it before then. */
  liveShopsDueAt: Date | null;
  /** Admin-added documents: what the upload form asks for, and the law behind it. */
  custom: Pick<ShopDocumentType, "lawNote" | "needsNumber" | "needsExpiry" | "needsAuthority"> | null;
}

export async function loadDocumentRuleSet(client: DbClient = db): Promise<DocumentRuleSet> {
  const [rules, types, upload] = await Promise.all([
    client.select().from(shopDocumentRules),
    client.select().from(shopDocumentTypes).where(eq(shopDocumentTypes.status, "ACTIVE")).orderBy(asc(shopDocumentTypes.label)),
    getRule("documentUpload"),
  ]);
  return { rules, types, fssaiMustHaveSwitch: upload.fssaiMandatoryForFood };
}

/** The label a shop sees: a professional office's registration is named as such. */
function builtInLabel(key: string, fallback: string, shopType: string): string {
  if (key === "MEDICAL_REGISTRATION") {
    const licence = mandatoryLicenceFor(shopType);
    return licence?.docType === "MEDICAL_REGISTRATION" ? licence.label.en : "Medical registration";
  }
  if (key === "FSSAI") return "FSSAI licence";
  return fallback;
}

/**
 * Every document the rules ask of a shop of this type (none for "not asked"). Pure: the set is loaded once.
 * isDoctor: the shop is in a Health doctor category (shopIsDoctorSql).
 */
export function requirementsFromRuleSet(set: DocumentRuleSet, shopType: string, sellsFood: boolean, isDoctor = false): ShopDocumentRequirement[] {
  const out: ShopDocumentRequirement[] = [];
  for (const doc of BUILT_IN_RULE_DOCUMENTS) {
    const rule = pickRule(set.rules, doc.key, shopType, sellsFood, isDoctor);
    if (!rule) continue;
    const level = doc.key === "FSSAI" && rule.level === "MUST_HAVE" && !set.fssaiMustHaveSwitch ? "PROMISE" : rule.level;
    out.push({ key: doc.key, label: builtInLabel(doc.key, doc.label, shopType), kind: doc.kind, level, liveShopsDueAt: rule.liveShopsDueAt, custom: null });
  }
  for (const type of set.types) {
    const rule = pickRule(set.rules, type.key, shopType, sellsFood, isDoctor);
    if (!rule) continue;
    out.push({
      key: type.key,
      label: type.label,
      kind: "custom",
      level: rule.level,
      liveShopsDueAt: rule.liveShopsDueAt,
      custom: { lawNote: type.lawNote, needsNumber: type.needsNumber, needsExpiry: type.needsExpiry, needsAuthority: type.needsAuthority },
    });
  }
  return out;
}

/**
 * The shop is a doctor: one of its shop categories is in a Health doctor group (owner, 22-Nov-2026,
 * H-52) — General & family, Specialists, Women & child, Dental, Eye & ENT, Mind, AYUSH or Animal care;
 * not Therapy or Diagnostics. Matches on the group, so a specialty an admin adds to one of them counts.
 */
export function shopIsDoctorSql(shopId?: string): SQL<boolean> {
  // Without an id: the "shops" row of the outer query. Written out in full because drizzle leaves a
  // single-table select's columns unqualified, and "id" alone is ambiguous inside the subquery.
  const shop = shopId === undefined ? sql.raw(`"shops"."id"`) : sql`${shopId}`;
  return sql<boolean>`exists (select 1 from shop_category_mapping m join shop_categories c on c.id = m.category_id where m.shop_id = ${shop} and c.group_name in ${[...DOCTOR_GROUP_NAMES]})`;
}

async function traitsOf(shop: Pick<Shop, "id" | "shopType">, client: DbClient): Promise<{ sellsFood: boolean; isDoctor: boolean }> {
  const [row] = await client
    .select({ food: sql<boolean>`shop_sells_food(${shop.id}, ${shop.shopType}::text)`, doctor: shopIsDoctorSql(shop.id) })
    .from(shops)
    .where(eq(shops.id, shop.id));
  return { sellsFood: row?.food ?? false, isDoctor: row?.doctor ?? false };
}

/** The documents this shop needs, from the admin's rules. */
export async function documentRequirementsFor(
  shop: Pick<Shop, "id" | "shopType">,
  client: DbClient = db,
  options: { sellsFood?: boolean; isDoctor?: boolean; set?: DocumentRuleSet } = {},
): Promise<ShopDocumentRequirement[]> {
  const set = options.set ?? (await loadDocumentRuleSet(client));
  const traits = options.sellsFood !== undefined && options.isDoctor !== undefined ? null : await traitsOf(shop, client);
  const sellsFood = options.sellsFood ?? traits!.sellsFood;
  const isDoctor = options.isDoctor ?? traits!.isDoctor;
  return requirementsFromRuleSet(set, shop.shopType, sellsFood, isDoctor);
}

/* ======================================================= what is on file */

const SELLER_WITH_TEAM = new Set(["PENDING", "MANUAL_REVIEW"]);

export interface RequirementOnFile extends ShopDocumentRequirement {
  /** Verified, or sent and waiting for GoKesari's team. */
  onFile: boolean;
  /** Sent and waiting for GoKesari's team. */
  withTeam: boolean;
}

/**
 * What the shop has given, as one shop's document rows. Shop Act / Udyam: the seller verification
 * (verified, or waiting for the team). FSSAI: a valid licence on file, or one waiting for the team
 * (document-uploads.ts fssaiStatus). Licences and admin-added documents: submitted or approved in the
 * legal-documents register.
 */
export async function requirementsOnFile(
  shop: Pick<Shop, "id" | "shopType">,
  client: DbClient = db,
  options: { requirements?: ShopDocumentRequirement[] } = {},
): Promise<RequirementOnFile[]> {
  const requirements = options.requirements ?? (await documentRequirementsFor(shop, client));
  if (requirements.length === 0) return [];
  const [seller, legal] = await Promise.all([
    client.select({ docType: sellerVerifications.docType, status: sellerVerifications.status }).from(sellerVerifications).where(eq(sellerVerifications.shopId, shop.id)),
    client
      .select({ docType: shopLegalDocuments.docType, licenceKey: shopLegalDocuments.licenceKey, status: shopLegalDocuments.status })
      .from(shopLegalDocuments)
      .where(eq(shopLegalDocuments.shopId, shop.id)),
  ]);
  const out: RequirementOnFile[] = [];
  for (const req of requirements) {
    let onFile = false;
    let withTeam = false;
    if (req.key === "FSSAI") {
      const { fssaiStatus } = await import("./document-uploads");
      const status = seller.find((s) => s.docType === "FSSAI")?.status ?? "";
      withTeam = SELLER_WITH_TEAM.has(status);
      onFile = withTeam || (await fssaiStatus(shop, client)).onFile;
    } else if (req.kind === "seller") {
      const status = seller.find((s) => s.docType === req.key)?.status ?? "";
      withTeam = SELLER_WITH_TEAM.has(status);
      onFile = status === "VERIFIED" || withTeam;
    } else {
      const row = legal.find((l) =>
        req.kind === "custom" ? l.docType === "OTHER_LICENCE" && l.licenceKey === req.key : l.docType === req.key && l.licenceKey === "",
      );
      onFile = row?.status === "SUBMITTED" || row?.status === "APPROVED";
      withTeam = row?.status === "SUBMITTED";
    }
    out.push({ ...req, onFile, withTeam });
  }
  return out;
}

/* ============================================================== admin */

export interface DocumentRuleView {
  id: string;
  scope: string;
  scopeLabel: string;
  level: DocumentLevel;
  liveShopsDueAt: string | null;
  note: string | null;
  updatedAt: string;
}

export interface DocumentRulesAdminView {
  documents: {
    key: string;
    label: string;
    kind: RuleDocumentKind;
    builtIn: boolean;
    status: "ACTIVE" | "INACTIVE";
    lawNote: string | null;
    labelHi: string | null;
    labelMr: string | null;
    needsNumber: boolean;
    needsExpiry: boolean;
    needsAuthority: boolean;
    rules: DocumentRuleView[];
  }[];
  shopTypes: { key: string; label: string }[];
  promiseDays: number;
}

const SCOPE_ORDER = (scope: string) => (scope === "ALL" ? 0 : scope === "FOOD" ? 1 : 2);

export async function getDocumentRulesAdmin(): Promise<DocumentRulesAdminView> {
  const [rules, types, shopTypes, followUp] = await Promise.all([
    db.select().from(shopDocumentRules),
    db.select().from(shopDocumentTypes).orderBy(asc(shopDocumentTypes.label)),
    listShopTypes({ includeInactive: true }),
    getRule("shopDocumentFollowUp"),
  ]);
  const typeLabels = Object.fromEntries(shopTypes.map((t) => [t.key, t.label]));
  const now = Date.now();
  const viewRules = (key: string): DocumentRuleView[] =>
    rules
      .filter((r) => r.docKey === key)
      .sort((a, b) => SCOPE_ORDER(a.scope) - SCOPE_ORDER(b.scope) || scopeLabel(a.scope, typeLabels).localeCompare(scopeLabel(b.scope, typeLabels)))
      .map((r) => ({
        id: r.id,
        scope: r.scope,
        scopeLabel: scopeLabel(r.scope, typeLabels),
        level: r.level,
        // Only while it is still ahead: after it, shops already live are chased like any other.
        liveShopsDueAt: r.liveShopsDueAt && r.liveShopsDueAt.getTime() > now ? r.liveShopsDueAt.toISOString() : null,
        note: r.note,
        updatedAt: r.updatedAt.toISOString(),
      }));
  return {
    documents: [
      ...BUILT_IN_RULE_DOCUMENTS.map((d) => ({
        key: d.key,
        label: d.label,
        kind: d.kind,
        builtIn: true,
        status: "ACTIVE" as const,
        lawNote: null,
        labelHi: null,
        labelMr: null,
        needsNumber: true,
        needsExpiry: d.key === "FSSAI" || d.key === "DRUG_LICENCE",
        needsAuthority: false,
        rules: viewRules(d.key),
      })),
      ...types.map((t) => ({
        key: t.key,
        label: t.label,
        kind: "custom" as const,
        builtIn: false,
        status: t.status,
        lawNote: t.lawNote,
        labelHi: t.labelHi,
        labelMr: t.labelMr,
        needsNumber: t.needsNumber,
        needsExpiry: t.needsExpiry,
        needsAuthority: t.needsAuthority,
        rules: viewRules(t.key),
      })),
    ],
    shopTypes: shopTypes.filter((t) => t.status === "ACTIVE").map((t) => ({ key: t.key, label: t.label })),
    promiseDays: followUp.promiseDays,
  };
}

function assertAdmin(actor: Actor): void {
  if (actor.role !== "ADMIN" || !actor.id) throw forbidden("Only an admin can change which documents shops need.");
}

async function assertKnownDocument(docKey: string, client: DbClient): Promise<string> {
  if (isBuiltInRuleDocKey(docKey)) return BUILT_IN_RULE_DOCUMENTS.find((d) => d.key === docKey)!.label;
  if (isCustomDocKey(docKey)) {
    const [type] = await client.select().from(shopDocumentTypes).where(eq(shopDocumentTypes.key, docKey));
    if (type) {
      if (type.status !== "ACTIVE") throw conflict(`${type.label} is switched off. Switch it on before giving it rules.`);
      return type.label;
    }
  }
  throw notFound("Document");
}

export interface SaveDocumentRuleInput {
  docKey: string;
  scope: string;
  level: DocumentLevel;
  /** When the rule makes the document needed for shops already live: days they get (default promiseDays). */
  liveShopDays?: number | null;
  note?: string | null;
}

/**
 * Sets the level of one document for one scope (insert or update). A rule that makes the document
 * needed where it was not (new, or raised from optional) gives shops already live `liveShopDays`
 * before the follow-up may suspend them for it; a rule already needing it keeps its date.
 */
export async function saveDocumentRule(input: SaveDocumentRuleInput, actor: Actor): Promise<ShopDocumentRule> {
  assertAdmin(actor);
  if (!isRuleScope(input.scope)) throw validationFailed("Choose who the rule applies to.");
  const type = scopeShopType(input.scope);
  if (type && !(await listShopTypes({ includeInactive: true })).some((t) => t.key === type)) throw validationFailed("Unknown shop type.");
  const note = input.note?.trim() || null;
  if (note && note.length > 300) throw validationFailed("Keep the note under 300 characters.");
  const days = input.liveShopDays ?? (await getRule("shopDocumentFollowUp")).promiseDays;
  if (!Number.isInteger(days) || days < 7 || days > 365) throw validationFailed("Give shops already live between 7 and 365 days.");

  return db.transaction(async (tx) => {
    const label = await assertKnownDocument(input.docKey, tx);
    const [existing] = await tx
      .select()
      .from(shopDocumentRules)
      .where(and(eq(shopDocumentRules.docKey, input.docKey), eq(shopDocumentRules.scope, input.scope)))
      .for("update");
    const now = new Date();
    const raised = input.level !== "OPTIONAL" && (!existing || existing.level === "OPTIONAL");
    const liveShopsDueAt = raised ? new Date(now.getTime() + days * DAY_MS) : (existing?.liveShopsDueAt ?? null);
    const [saved] = await tx
      .insert(shopDocumentRules)
      .values({ docKey: input.docKey, scope: input.scope, level: input.level, liveShopsDueAt, note, updatedBy: actor.id })
      .onConflictDoUpdate({
        target: [shopDocumentRules.docKey, shopDocumentRules.scope],
        set: { level: input.level, liveShopsDueAt, note, updatedBy: actor.id, updatedAt: now },
      })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_DOCUMENT_RULE_SAVED,
        entityType: "shop_document_rule",
        entityId: saved.id,
        previousValue: existing ? { level: existing.level, liveShopsDueAt: existing.liveShopsDueAt?.toISOString() ?? null, note: existing.note } : null,
        newValue: { docKey: input.docKey, document: label, scope: input.scope, level: input.level, liveShopsDueAt: liveShopsDueAt?.toISOString() ?? null, note },
      },
      tx,
    );
    return saved;
  });
}

/** Removes a rule: the document falls back to a broader rule, or is no longer asked of that scope. */
export async function removeDocumentRule(ruleId: string, actor: Actor): Promise<void> {
  assertAdmin(actor);
  await db.transaction(async (tx) => {
    const [removed] = await tx.delete(shopDocumentRules).where(eq(shopDocumentRules.id, ruleId)).returning();
    if (!removed) throw notFound("Rule");
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_DOCUMENT_RULE_REMOVED,
        entityType: "shop_document_rule",
        entityId: removed.id,
        previousValue: { docKey: removed.docKey, scope: removed.scope, level: removed.level, liveShopsDueAt: removed.liveShopsDueAt?.toISOString() ?? null },
      },
      tx,
    );
  });
}

export interface ShopDocumentTypeInput {
  label: string;
  labelHi?: string | null;
  labelMr?: string | null;
  lawNote: string;
  needsNumber: boolean;
  needsExpiry: boolean;
  needsAuthority: boolean;
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 &/().,'-]*$/;

function cleanTypeInput(input: Partial<ShopDocumentTypeInput>): Partial<ShopDocumentTypeInput> {
  const out: Partial<ShopDocumentTypeInput> = { ...input };
  if (input.label !== undefined) {
    const label = input.label.trim().replace(/\s+/g, " ");
    if (label.length < 3 || label.length > 80 || !LABEL_RE.test(label)) {
      throw validationFailed("Name the document in 3–80 characters: letters, digits, spaces and & / ( ) . , ' -", { fields: { label: "Check the name." } });
    }
    if (BUILT_IN_RULE_DOCUMENTS.some((d) => d.label.toLowerCase() === label.toLowerCase())) {
      throw conflict(`${label} is already in the list. Change its rules instead.`);
    }
    out.label = label;
  }
  for (const key of ["labelHi", "labelMr"] as const) {
    if (input[key] !== undefined) {
      const value = input[key]?.trim().replace(/\s+/g, " ") || null;
      if (value && value.length > 120) throw validationFailed("Keep the translated name under 120 characters.", { fields: { [key]: "Too long." } });
      out[key] = value;
    }
  }
  if (input.lawNote !== undefined) {
    const note = input.lawNote.trim().replace(/\s+/g, " ");
    if (note.length < 5 || note.length > 300) {
      throw validationFailed("Say which law (or why) the document is needed, in 5–300 characters.", { fields: { lawNote: "Required." } });
    }
    out.lawNote = note;
  }
  return out;
}

/** Adds a document the law newly requires. It has no rule yet: give it one (who needs it, and how). */
export async function addShopDocumentType(input: ShopDocumentTypeInput, actor: Actor): Promise<ShopDocumentType> {
  assertAdmin(actor);
  const clean = cleanTypeInput(input) as ShopDocumentTypeInput;
  const key = customDocKeyFromLabel(clean.label);
  if (!isCustomDocKey(key) || key.length < 6) throw validationFailed("Name the document with at least two letters or digits.");
  return db.transaction(async (tx) => {
    const [clash] = await tx
      .select({ key: shopDocumentTypes.key })
      .from(shopDocumentTypes)
      .where(sql`${shopDocumentTypes.key} = ${key} OR lower(${shopDocumentTypes.label}) = ${clean.label.toLowerCase()}`)
      .limit(1);
    if (clash) throw conflict(`A document named ${clean.label} is already in the list.`);
    const [created] = await tx
      .insert(shopDocumentTypes)
      .values({
        key,
        label: clean.label,
        labelHi: clean.labelHi ?? null,
        labelMr: clean.labelMr ?? null,
        lawNote: clean.lawNote,
        needsNumber: clean.needsNumber,
        needsExpiry: clean.needsExpiry,
        needsAuthority: clean.needsAuthority,
        createdBy: actor.id,
      })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_DOCUMENT_TYPE_ADDED,
        entityType: "shop_document_type",
        entityId: key,
        newValue: { key, label: created.label, lawNote: created.lawNote, needsNumber: created.needsNumber, needsExpiry: created.needsExpiry, needsAuthority: created.needsAuthority },
      },
      tx,
    );
    return created;
  });
}

/**
 * Changes an admin-added document: its names, the law, what the form asks for, or switches it off
 * (INACTIVE: no longer asked of any shop; what shops uploaded stays). The key never changes, so what
 * shops already uploaded stays attached to it.
 */
export async function updateShopDocumentType(
  key: string,
  input: Partial<ShopDocumentTypeInput> & { status?: "ACTIVE" | "INACTIVE" },
  actor: Actor,
): Promise<ShopDocumentType> {
  assertAdmin(actor);
  const { status, ...fields } = input;
  const clean = cleanTypeInput(fields);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(shopDocumentTypes).where(eq(shopDocumentTypes.key, key)).for("update");
    if (!existing) throw notFound("Document");
    if (clean.label && clean.label.toLowerCase() !== existing.label.toLowerCase()) {
      const [clash] = await tx
        .select({ key: shopDocumentTypes.key })
        .from(shopDocumentTypes)
        .where(sql`lower(${shopDocumentTypes.label}) = ${clean.label.toLowerCase()} AND ${shopDocumentTypes.key} <> ${key}`)
        .limit(1);
      if (clash) throw conflict(`A document named ${clean.label} is already in the list.`);
    }
    const [updated] = await tx
      .update(shopDocumentTypes)
      .set({ ...clean, ...(status ? { status } : {}), updatedAt: new Date() })
      .where(eq(shopDocumentTypes.key, key))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_DOCUMENT_TYPE_UPDATED,
        entityType: "shop_document_type",
        entityId: key,
        previousValue: {
          label: existing.label,
          labelHi: existing.labelHi,
          labelMr: existing.labelMr,
          lawNote: existing.lawNote,
          needsNumber: existing.needsNumber,
          needsExpiry: existing.needsExpiry,
          needsAuthority: existing.needsAuthority,
          status: existing.status,
        },
        newValue: { ...clean, ...(status ? { status } : {}) },
      },
      tx,
    );
    return updated;
  });
}

/** An admin-added document, active or not (the upload form and the review queue). */
export async function getShopDocumentType(key: string, client: DbClient = db): Promise<ShopDocumentType | null> {
  if (!isCustomDocKey(key)) return null;
  const [row] = await client.select().from(shopDocumentTypes).where(eq(shopDocumentTypes.key, key));
  return row ?? null;
}

/**
 * DF-09: the must-have documents a shop has not given (not on file, not with the team), FSSAI left out
 * (it keeps its own approval check, document-uploads.ts assertFssaiAllowsApproval). Labels.
 */
export async function missingMustHaveDocuments(shop: Pick<Shop, "id" | "shopType">, client: DbClient = db): Promise<string[]> {
  const requirements = (await documentRequirementsFor(shop, client)).filter((r) => r.level === "MUST_HAVE" && r.key !== "FSSAI");
  if (requirements.length === 0) return [];
  return (await requirementsOnFile(shop, client, { requirements })).filter((d) => !d.onFile).map((d) => d.label);
}
