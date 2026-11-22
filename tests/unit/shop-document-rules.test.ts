/**
 * Shop document rules (DF-09) and the "Doctors" scope (owner, 22-Nov-2026, H-52): who a rule applies to,
 * which rule wins, and migration 0165 that adds the scope with the medical registration on the promise.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DOCTOR_GROUP_NAMES, HEALTH_SPECIALTY_GROUPS } from "@/lib/health/specialties";
import { DOCTOR_SCOPE_LABEL, isRuleScope, pickRule, scopeLabel, type RuleLike } from "@/lib/shop-document-rules";

const root = process.cwd();
const MIGRATION = readFileSync(path.join(root, "drizzle", "0165_doctor_document_scope.sql"), "utf8");
const ROLLBACK = readFileSync(path.join(root, "scripts", "rollback-0165.sql"), "utf8");

describe("rule scopes", () => {
  it("accept the doctor scope next to all shops, food shops and one shop type", () => {
    for (const scope of ["ALL", "FOOD", "DOCTOR", "TYPE:DOCTOR_CLINIC"]) expect(isRuleScope(scope), scope).toBe(true);
    for (const scope of ["DOCTORS", "doctor", "TYPE:", "HEALTH"]) expect(isRuleScope(scope), scope).toBe(false);
    expect(scopeLabel("DOCTOR")).toBe(DOCTOR_SCOPE_LABEL);
  });

  it("pick the most specific rule: shop type, then doctors, then food shops, then all shops", () => {
    const rules: RuleLike[] = [
      { docKey: "MEDICAL_REGISTRATION", scope: "ALL", level: "OPTIONAL" },
      { docKey: "MEDICAL_REGISTRATION", scope: "FOOD", level: "OPTIONAL" },
      { docKey: "MEDICAL_REGISTRATION", scope: "DOCTOR", level: "PROMISE" },
      { docKey: "MEDICAL_REGISTRATION", scope: "TYPE:PROFESSIONAL_OFFICE", level: "MUST_HAVE" },
    ];
    expect(pickRule(rules, "MEDICAL_REGISTRATION", "PROFESSIONAL_OFFICE", false, true)?.scope).toBe("TYPE:PROFESSIONAL_OFFICE");
    expect(pickRule(rules, "MEDICAL_REGISTRATION", "HARDWARE_STORE", true, true)?.scope).toBe("DOCTOR");
    expect(pickRule(rules, "MEDICAL_REGISTRATION", "HARDWARE_STORE", true, false)?.scope).toBe("FOOD");
    expect(pickRule(rules, "MEDICAL_REGISTRATION", "HARDWARE_STORE", false)?.scope).toBe("ALL");
    expect(pickRule(rules.slice(2, 3), "MEDICAL_REGISTRATION", "HARDWARE_STORE", false, false)).toBeNull();
  });
});

describe("doctor groups", () => {
  it("are every Health group but Therapy and Diagnostics", () => {
    expect(HEALTH_SPECIALTY_GROUPS.filter((g) => !DOCTOR_GROUP_NAMES.includes(g.name)).map((g) => g.short)).toEqual(["Therapy", "Diagnostics"]);
  });
});

describe("migration 0165", () => {
  it("lets the scope check take DOCTOR and seeds the medical registration on the promise, 90 days for shops already live", () => {
    expect(MIGRATION).toMatch(/ADD CONSTRAINT "shop_document_rules_scope" CHECK \([^;]*"scope" = 'DOCTOR'/);
    expect(MIGRATION).toMatch(/\('MEDICAL_REGISTRATION', 'DOCTOR', 'PROMISE', now\(\) \+ interval '90 days'/);
    expect(MIGRATION).toMatch(/ON CONFLICT \("doc_key", "scope"\) DO NOTHING/);
    expect(MIGRATION).not.toMatch(/DELETE\s+FROM|DROP\s+TABLE/i);
  });

  it("has a rollback that removes the doctor rules before putting the old check back", () => {
    expect(ROLLBACK.indexOf(`DELETE FROM "shop_document_rules" WHERE "scope" = 'DOCTOR'`)).toBeGreaterThan(-1);
    expect(ROLLBACK.indexOf("DELETE FROM")).toBeLessThan(ROLLBACK.indexOf("ADD CONSTRAINT"));
    expect(ROLLBACK).not.toMatch(/'DOCTOR' OR/);
  });

  it("is in the migration journal", () => {
    const journal = JSON.parse(readFileSync(path.join(root, "drizzle", "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain("0165_doctor_document_scope");
  });
});
