/**
 * GoKesari Health: the drug master (brand / generic search for the prescription pad, telemedicine
 * lists, schedules) and the ICD-10 diagnosis list. Admins keep both (Admin → Health), including CSV import.
 */
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";

import { forbidden, validationFailed } from "@/lib/errors";
import { DRUG_FORMS, DRUG_SCHEDULES, TELE_LISTS } from "@/lib/health/constants";
import { db } from "@/server/db";
import { healthDrugMaster, healthIcd10, type HealthDrug } from "@/server/db/schema";
import { recordAudit, AUDIT_ACTIONS } from "@/server/services/audit";
import { isHealthStaff, type HealthActor } from "./access";

const clean = (q: string) => q.trim().toLowerCase().replace(/[%_\\]/g, "").slice(0, 60);

export async function searchDrugs(q: string, limit = 20): Promise<HealthDrug[]> {
  const term = clean(q);
  if (term.length < 2) return [];
  return db
    .select()
    .from(healthDrugMaster)
    .where(and(eq(healthDrugMaster.status, "ACTIVE"), or(ilike(healthDrugMaster.genericName, `${term}%`), ilike(healthDrugMaster.brandName, `${term}%`), ilike(healthDrugMaster.genericName, `%${term}%`), ilike(healthDrugMaster.brandName, `%${term}%`))))
    .orderBy(sql`case when lower(${healthDrugMaster.brandName}) like ${`${term}%`} or lower(${healthDrugMaster.genericName}) like ${`${term}%`} then 0 else 1 end`, asc(healthDrugMaster.genericName), asc(healthDrugMaster.strength))
    .limit(Math.min(limit, 50));
}

export async function searchIcd10(q: string, limit = 20): Promise<{ code: string; title: string }[]> {
  const term = clean(q);
  if (term.length < 2) return [];
  return db
    .select({ code: healthIcd10.code, title: healthIcd10.title })
    .from(healthIcd10)
    .where(or(ilike(healthIcd10.code, `${term}%`), ilike(healthIcd10.title, `%${term}%`)))
    .orderBy(asc(healthIcd10.code))
    .limit(Math.min(limit, 50));
}

export const drugInput = z.object({
  id: z.string().uuid().nullish(),
  genericName: z.string().trim().min(2).max(160),
  brandName: z.string().trim().max(120).nullish(),
  strength: z.string().trim().max(60).nullish(),
  form: z.enum(DRUG_FORMS),
  manufacturer: z.string().trim().max(120).nullish(),
  schedule: z.enum(DRUG_SCHEDULES),
  rxRequired: z.boolean(),
  teleList: z.enum(TELE_LISTS),
  onlineSaleAllowed: z.boolean(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
});

function requireStaff(actor: HealthActor) {
  if (!isHealthStaff(actor)) throw forbidden("Only GoKesari Health staff can change the drug master.");
}

/** Schedule X and NDPS medicines are never allowed by teleconsultation or for online sale. */
function enforceRules<T extends { schedule: string; teleList: string; onlineSaleAllowed: boolean }>(d: T): T {
  if (d.schedule === "X" || d.schedule === "NDPS") return { ...d, teleList: "PROHIBITED", onlineSaleAllowed: false };
  return d;
}

export async function listDrugs(actor: HealthActor, q = "", limit = 200): Promise<HealthDrug[]> {
  requireStaff(actor);
  const term = clean(q);
  return db
    .select()
    .from(healthDrugMaster)
    .where(term ? or(ilike(healthDrugMaster.genericName, `%${term}%`), ilike(healthDrugMaster.brandName, `%${term}%`)) : undefined)
    .orderBy(asc(healthDrugMaster.genericName), asc(healthDrugMaster.strength))
    .limit(limit);
}

export async function saveDrug(raw: unknown, actor: HealthActor): Promise<HealthDrug> {
  requireStaff(actor);
  const input = enforceRules(drugInput.parse(raw));
  const values = { ...input, brandName: input.brandName || null, strength: input.strength || null, manufacturer: input.manufacturer || null, updatedBy: actor.id, updatedAt: new Date() };
  const { id, ...rest } = values;
  const [row] = id ? await db.update(healthDrugMaster).set(rest).where(eq(healthDrugMaster.id, id)).returning() : await db.insert(healthDrugMaster).values(rest).returning();
  if (!row) throw validationFailed("Medicine not found.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_DRUG_MASTER, entityType: "health_drug", entityId: row.id, newValue: { genericName: row.genericName, teleList: row.teleList, schedule: row.schedule } });
  return row;
}

/** Splits one CSV line (quotes allowed). */
export function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const yes = (v: string | undefined) => /^(y|yes|true|1)$/i.test(v ?? "");

/**
 * CSV import. Header row with: generic_name, brand_name, strength, form, schedule, rx_required,
 * tele_list, online_sale_allowed, manufacturer. Existing rows (same generic + brand + strength + form)
 * are updated. Returns counts and the first errors.
 */
export async function importDrugsCsv(csv: string, actor: HealthActor): Promise<{ added: number; updated: number; errors: string[] }> {
  requireStaff(actor);
  const lines = csv.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (lines.length < 2) throw validationFailed("The file needs a header row and at least one medicine.");
  const header = csvCells(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const col = (row: string[], name: string) => row[header.indexOf(name)] ?? "";
  if (!header.includes("generic_name")) throw validationFailed("The header must include generic_name.");
  let added = 0;
  let updated = 0;
  const errors: string[] = [];
  for (let i = 1; i < lines.length && i <= 20_000; i++) {
    const row = csvCells(lines[i]);
    const parsed = drugInput.safeParse({
      genericName: col(row, "generic_name"),
      brandName: col(row, "brand_name") || null,
      strength: col(row, "strength") || null,
      form: (col(row, "form") || "TABLET").toUpperCase(),
      manufacturer: col(row, "manufacturer") || null,
      schedule: (col(row, "schedule") || "H").toUpperCase(),
      rxRequired: header.includes("rx_required") ? yes(col(row, "rx_required")) : true,
      teleList: (col(row, "tele_list") || "A").toUpperCase(),
      onlineSaleAllowed: header.includes("online_sale_allowed") ? yes(col(row, "online_sale_allowed")) : true,
    });
    if (!parsed.success) {
      if (errors.length < 20) errors.push(`Line ${i + 1}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      continue;
    }
    const d = enforceRules(parsed.data);
    const [existing] = await db
      .select({ id: healthDrugMaster.id })
      .from(healthDrugMaster)
      .where(
        and(
          sql`lower(${healthDrugMaster.genericName}) = ${d.genericName.toLowerCase()}`,
          sql`lower(coalesce(${healthDrugMaster.brandName}, '')) = ${(d.brandName ?? "").toLowerCase()}`,
          sql`lower(coalesce(${healthDrugMaster.strength}, '')) = ${(d.strength ?? "").toLowerCase()}`,
          eq(healthDrugMaster.form, d.form),
        ),
      );
    const values = { genericName: d.genericName, brandName: d.brandName ?? null, strength: d.strength ?? null, form: d.form, manufacturer: d.manufacturer ?? null, schedule: d.schedule, rxRequired: d.rxRequired, teleList: d.teleList, onlineSaleAllowed: d.onlineSaleAllowed, updatedBy: actor.id, updatedAt: new Date() };
    if (existing) {
      await db.update(healthDrugMaster).set(values).where(eq(healthDrugMaster.id, existing.id));
      updated++;
    } else {
      await db.insert(healthDrugMaster).values(values);
      added++;
    }
  }
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_DRUG_MASTER, entityType: "health_drug", newValue: { import: true, added, updated, errors: errors.length } });
  return { added, updated, errors };
}

/** ICD-10 CSV import: code,title[,chapter]. */
export async function importIcdCsv(csv: string, actor: HealthActor): Promise<{ added: number }> {
  requireStaff(actor);
  let added = 0;
  for (const line of csv.replace(/\r/g, "").split("\n").slice(1)) {
    const [code, title, chapter] = csvCells(line);
    if (!code || !title || !/^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/i.test(code)) continue;
    await db.insert(healthIcd10).values({ code: code.toUpperCase(), title: title.slice(0, 300), chapter: chapter || null }).onConflictDoUpdate({ target: healthIcd10.code, set: { title: title.slice(0, 300) } });
    added++;
  }
  return { added };
}
