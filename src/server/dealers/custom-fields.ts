/**
 * Dealership & Franchise Platform phase 5 (owner brief 23-Nov-2026; docs/dealer-platform/PHASE_5_CUSTOM_FIELDS.md):
 * the custom fields an admin adds to a scheme version.
 *
 *   - asked on the application (useIn.registration), shown or hidden by `showWhen`;
 *   - checked on submit: required fields filled, FILE fields uploaded, the scheme's eligibility rules true;
 *   - numeric answers are formula variables cf_<key> in eligibility rules and commission formulas;
 *   - shown to staff on the dealer's page (useIn.reports).
 * Files are stored encrypted (like dealer documents): PDF, JPEG, PNG or WebP up to 5 MB.
 */
import { desc, eq } from "drizzle-orm";

import { checkCustomValues, customVariables, failedEligibility, type CustomField, type CustomValues, type SchemeTerms } from "@/lib/dealer-schemes";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { decryptBytes, encryptBytes } from "@/lib/pan-crypto";
import { db, type DbClient } from "@/server/db";
import { dealerCustomFiles, dealers, type Dealer, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

import { chosenScheme } from "./scheme-registration";
import { DOC_MIME, sniffMime } from "./service";

interface Actor {
  id: string;
  role: UserRole;
}

const EDITABLE = ["DRAFT", "REJECTED"];
const MAX_BYTES = 5 * 1024 * 1024;

export interface CustomFileView {
  id: string;
  fieldKey: string;
  fileName: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface ApplicationCustomFields {
  fields: CustomField[];
  values: CustomValues;
  files: CustomFileView[];
}

async function latestFiles(dealerId: string, client: DbClient = db): Promise<CustomFileView[]> {
  const rows = await client
    .select({ id: dealerCustomFiles.id, fieldKey: dealerCustomFiles.fieldKey, fileName: dealerCustomFiles.fileName, sizeBytes: dealerCustomFiles.sizeBytes, uploadedAt: dealerCustomFiles.uploadedAt })
    .from(dealerCustomFiles)
    .where(eq(dealerCustomFiles.dealerId, dealerId))
    .orderBy(desc(dealerCustomFiles.uploadedAt));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.fieldKey) ? false : (seen.add(r.fieldKey), true))).map((r) => ({ ...r, uploadedAt: r.uploadedAt.toISOString() }));
}

/** The chosen scheme's application fields, the answers so far and the uploaded files. */
export async function applicationCustomFields(dealer: Dealer, client: DbClient = db): Promise<ApplicationCustomFields> {
  const offer = await chosenScheme(dealer, client);
  const fields = (offer?.terms.customFields ?? []).filter((f) => f.useIn.registration);
  return { fields, values: dealer.customValues ?? {}, files: fields.some((f) => f.type === "FILE") ? await latestFiles(dealer.id, client) : [] };
}

async function editableDealer(actor: Actor): Promise<Dealer> {
  const [dealer] = await db.select().from(dealers).where(eq(dealers.userId, actor.id));
  if (!dealer) throw validationFailed("Save your details first.");
  if (!EDITABLE.includes(dealer.status)) throw conflict("Your application is already submitted.");
  return dealer;
}

/** Saves the answers (partial saves allowed; required fields are checked on submit). */
export async function saveCustomValues(actor: Actor, raw: Record<string, unknown>): Promise<CustomValues> {
  const dealer = await editableDealer(actor);
  const offer = await chosenScheme(dealer);
  const fields = offer?.terms.customFields ?? [];
  const { values, errors } = checkCustomValues(fields, raw, false);
  if (Object.keys(errors).length) throw validationFailed(Object.values(errors)[0], { fields: errors });
  await db.update(dealers).set({ customValues: values, updatedAt: new Date() }).where(eq(dealers.id, dealer.id));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_APPLICATION_SAVED, entityType: "dealer", entityId: dealer.id, newValue: { customFields: Object.keys(values) } });
  return values;
}

/** Uploads the file of a FILE-type field (replaces the previous one; the history is kept). */
export async function uploadCustomFile(actor: Actor, fieldKey: string, file: { name: string; bytes: Buffer }): Promise<CustomFileView> {
  const dealer = await editableDealer(actor);
  const offer = await chosenScheme(dealer);
  const field = offer?.terms.customFields.find((f) => f.key === fieldKey && f.type === "FILE" && f.useIn.registration);
  if (!field) throw notFound("Field");
  if (file.bytes.length === 0 || file.bytes.length > MAX_BYTES) throw validationFailed("The file must be up to 5 MB.");
  const mimeType = sniffMime(file.bytes);
  if (!mimeType || !DOC_MIME[mimeType]) throw validationFailed("Upload a PDF, JPEG, PNG or WebP file.");
  const fileName = (file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 100) || `${fieldKey}.${DOC_MIME[mimeType]}`).trim();
  const [row] = await db.insert(dealerCustomFiles).values({ dealerId: dealer.id, fieldKey, fileName, mimeType, sizeBytes: file.bytes.length, content: encryptBytes(file.bytes), uploadedBy: actor.id }).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_APPLICATION_SAVED, entityType: "dealer", entityId: dealer.id, newValue: { customFile: fieldKey, fileName, sizeBytes: file.bytes.length } });
  return { id: row.id, fieldKey, fileName, sizeBytes: row.sizeBytes, uploadedAt: row.uploadedAt.toISOString() };
}

/** A custom file's bytes, for its dealer or staff (audited for staff). */
export async function customFileContent(fileId: string, viewer: Actor): Promise<{ fileName: string; mimeType: string; bytes: Buffer }> {
  const [row] = await db.select({ f: dealerCustomFiles, userId: dealers.userId }).from(dealerCustomFiles).innerJoin(dealers, eq(dealers.id, dealerCustomFiles.dealerId)).where(eq(dealerCustomFiles.id, fileId));
  const staff = viewer.role === "ADMIN" || viewer.role === "OPERATOR";
  if (!row || (!staff && row.userId !== viewer.id)) throw notFound("File");
  if (staff) await recordAudit({ actorId: viewer.id, actorRole: viewer.role, action: AUDIT_ACTIONS.DEALER_DOCUMENT_VIEWED, entityType: "dealer", entityId: row.f.dealerId, newValue: { customFile: row.f.fieldKey, fileId } });
  return { fileName: row.f.fileName, mimeType: row.f.mimeType, bytes: decryptBytes(row.f.content) };
}

/**
 * On submit (inside the submit transaction): the scheme's required fields, files and eligibility rules. Throws a
 * validation error naming what is missing or which rule is not met.
 */
export async function checkCustomOnSubmit(dealer: Dealer, terms: SchemeTerms, tx: DbClient): Promise<void> {
  const fields = terms.customFields;
  if (!fields.length && !terms.eligibilityRules.length) return;
  const { values, errors } = checkCustomValues(fields, dealer.customValues ?? {}, true);
  const files = await latestFiles(dealer.id, tx);
  for (const f of fields) {
    if (f.type === "FILE" && f.required && f.useIn.registration && !files.some((x) => x.fieldKey === f.key)) errors[f.key] = `Upload ${f.label}.`;
  }
  if (Object.keys(errors).length) throw validationFailed(`Complete your scheme's questions: ${Object.values(errors).join(" ")}`, { fields: errors });
  const failed = failedEligibility(terms.eligibilityRules, customVariables(fields, values));
  if (failed.length) throw validationFailed(`You do not meet this scheme's conditions: ${failed.join(" ")}`, { fields: { eligibility: failed.join(" ") } });
}

/** Staff view of a dealer's answers (fields marked for reports), in field order. */
export function reportableAnswers(terms: Pick<SchemeTerms, "customFields">, values: CustomValues, files: CustomFileView[]): { label: string; value: string; fileId?: string }[] {
  return (terms.customFields ?? [])
    .filter((f) => f.useIn.reports)
    .map((f) => {
      if (f.type === "FILE") {
        const file = files.find((x) => x.fieldKey === f.key);
        return { label: f.label, value: file ? file.fileName : "not uploaded", fileId: file?.id };
      }
      if (f.type === "FORMULA") return { label: f.label, value: String(customVariables(terms.customFields ?? [], values)[`cf_${f.key}`] ?? "") };
      const v = values[f.key];
      const text = v === null || v === undefined ? "—" : Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : f.type === "CURRENCY" ? `₹${(Number(v) / 100).toLocaleString("en-IN")}` : f.type === "PERCENT" ? `${Number(v) / 100}%` : String(v);
      return { label: f.label, value: text };
    });
}

export async function dealerCustomFilesFor(dealerId: string): Promise<CustomFileView[]> {
  return latestFiles(dealerId);
}

/** For the calculator: a dealer's custom variables under his scheme's fields. */
export function dealerFormulaVariables(terms: Pick<SchemeTerms, "customFields">, dealer: Pick<Dealer, "customValues">): Record<string, number> {
  return customVariables(terms.customFields ?? [], dealer.customValues ?? {});
}

