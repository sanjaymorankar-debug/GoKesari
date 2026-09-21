/**
 * Renders the reference documents that must never drift from the code.
 *
 *   DATA_DICTIONARY.md  <- the workbook model (the same definitions build the DATA_DICTIONARY sheet)
 *   SOURCE_REGISTER.md  <- the source registry (status and legal basis of every source)
 *
 * `scripts/pmd/gen-docs.ts` writes them; `tests/unit/pmd-docs.test.ts` fails when a file on disk
 * differs from what this module renders, so a change to the model or registry cannot ship with
 * stale documentation.
 */
import { SOURCE_KIND_DEFAULTS } from "../config";
import { DICTIONARY_COLUMNS, dictionaryRows } from "../export/excel";
import { DATA_SHEETS, SHEET_ORDER, type SheetDef } from "../export/model";
import { SOURCE_REGISTRY } from "../sources/registry";
import type { SourceDefinition, SourceStatus } from "../types";

const GENERATED = (script: string, from: string) =>
  `> Generated from \`${from}\` by \`npm run pmd:docs\` - do not edit by hand. ` +
  `A unit test fails if this file differs from the code (\`${script}\`).\n`;

/** Table cells: no pipes, no line breaks. */
const cell = (v: unknown): string => (v == null || v === "" ? "-" : String(v).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim());

function table(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

/* ------------------------------------------------------------ data dictionary */

const RUN_SUMMARY_NOTE =
  "A fourteenth sheet, **RUN_SUMMARY**, follows the thirteen. It is not part of the brief's structure: it records what the file contains " +
  "(generation time, scope, row counts per sheet, what a blank means) and carries the Open Database Licence attribution that the open-data " +
  "sources require whenever their data is redistributed.";

export function renderDataDictionary(): string {
  const byName = new Map<string, SheetDef>(DATA_SHEETS.map((s) => [s.name, s]));
  const rows = dictionaryRows();
  const out: string[] = [
    "# Data dictionary - GOKESARI_PRODUCT_MASTER",
    "",
    GENERATED("tests/unit/pmd-docs.test.ts", "src/server/pmd/export/model.ts"),
    "Every field of the 13 workbook sheets, with its type, whether it is required, where it comes from in the PostgreSQL schema, and what it means. " +
      "The same definitions feed the workbook's own DATA_DICTIONARY sheet, so the two cannot disagree.",
    "",
    "## Conventions",
    "",
    "- **Missing data is never zero.** A missing text value is written `NOT_AVAILABLE`; a missing number, date or timestamp is left blank. `0` means zero.",
    "- **Money** is stored as integer minor units (paise) and shown in rupees. **Percentages** are shown as real Excel percentages.",
    "- **Timestamps** are UTC (`yyyy-mm-dd hh:mm:ss`); dates are `yyyy-mm-dd`.",
    "- **List** values are joined with `; `.",
    "- **Required** means the field should be present wherever the data exists; a blank is then highlighted as a data-quality finding.",
    "- **Derived** means computed for the export and not stored on the record (counts, scores, the best current price of a product).",
    "- **Prices are not product attributes.** PRODUCT_MASTER carries no price or MRP; prices live in PRODUCT_SELLER (current offers) and PRODUCT_PRICE_HISTORY.",
    "",
    RUN_SUMMARY_NOTE,
    "",
    "## Sheets",
    "",
    table(
      ["#", "Sheet", "Fields", "Purpose"],
      SHEET_ORDER.map((name, i) => [i + 1, `[${name}](#${i + 1}-${name.toLowerCase()})`, byName.get(name)?.columns.length ?? DICTIONARY_COLUMNS.length, byName.get(name)?.description ?? "The field definitions in this document, as a worksheet."]),
    ),
    "",
  ];

  SHEET_ORDER.forEach((name, i) => {
    const def = byName.get(name);
    out.push(`## ${i + 1}. ${name}`, "");
    out.push(def ? def.description : "The field definitions in this document, as a worksheet. It is generated from the model, not queried.", "");
    const headers = ["Field", "Type", "Required", "Derived", "Allowed values", "Database source", "Description"];
    if (def) {
      out.push(table(headers, rows.filter((r) => r[0] === name).map((r) => [`\`${r[1]}\``, r[2], r[3], r[4], r[6], r[7], r[8]])));
    } else {
      out.push(table(headers, DICTIONARY_COLUMNS.map((c) => [`\`${c.header}\``, "Text", c.required ? "Yes" : "No", "No", c.allowed?.join(", "), c.source, c.description])));
    }
    out.push("");
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/* ------------------------------------------------------------ source register */

const STATUS_ORDER: SourceStatus[] = ["ACTIVE", "PLANNED", "BLOCKED_NEEDS_AGREEMENT", "BLOCKED_TECHNICAL", "DISABLED"];
const STATUS_TITLE: Record<SourceStatus, string> = {
  ACTIVE: "Active - collects today",
  PLANNED: "Planned - lawful route identified, connector not built",
  BLOCKED_NEEDS_AGREEMENT: "Blocked - needs an agreement, licence or official API",
  BLOCKED_TECHNICAL: "Blocked - no lawful automated route (CAPTCHA / login / no API)",
  DISABLED: "Disabled",
};

function detail(s: SourceDefinition): string {
  const d = SOURCE_KIND_DEFAULTS[s.kind];
  const lines = [
    `### \`${s.key}\` - ${s.name}`,
    "",
    `- **Kind / access:** ${s.kind} / ${s.accessMethod}`,
    `- **Trust:** reliability ${s.reliability ?? d.reliability}, specification precedence ${s.specPrecedence ?? d.specPrecedence} (lower wins a conflict)`,
    `- **Legal basis / route:** ${s.legalBasis}`,
  ];
  if (s.licenseName) lines.push(`- **Licence:** ${s.licenseName}`);
  if (s.termsUrl) lines.push(`- **Terms:** ${s.termsUrl}`);
  if (s.robotsPolicy) lines.push(`- **robots.txt:** ${s.robotsPolicy}`);
  if (s.apiEndpoint) lines.push(`- **Endpoint:** ${s.apiEndpoint}`);
  if (s.authEnvVar) lines.push(`- **Credentials:** environment variable \`${s.authEnvVar}\` (the secret is never stored)`);
  if (s.collectionFrequency) lines.push(`- **Frequency:** ${s.collectionFrequency}`);
  if (s.rateLimitPerMin) lines.push(`- **Rate limit:** ${s.rateLimitPerMin} requests/minute`);
  if (s.parserKey) lines.push(`- **Parser:** \`${s.parserKey}\``);
  if (s.notes) lines.push(`- **Notes:** ${s.notes}`);
  return lines.join("\n");
}

export function renderSourceRegister(): string {
  const groups = STATUS_ORDER.map((status) => ({ status, sources: SOURCE_REGISTRY.filter((s) => s.status === status) })).filter((g) => g.sources.length);
  const out: string[] = [
    "# Source register",
    "",
    GENERATED("tests/unit/pmd-docs.test.ts", "src/server/pmd/sources/registry.ts"),
    "Every source named in the brief, with its status and the lawful basis on which it can (or cannot yet) be collected. " +
      "Only `ACTIVE` sources can run: the runner refuses anything else, and the database refuses to mark a non-active source enabled. " +
      "Nothing in the platform collects from a marketplace; those entries exist so the gap is visible and the route to close it is written down.",
    "",
    `**${SOURCE_REGISTRY.length} sources:** ` + groups.map((g) => `${g.sources.length} ${g.status.toLowerCase().replace(/_/g, " ")}`).join(", ") + ".",
    "",
    "## Summary",
    "",
    table(
      ["Source", "Name", "Kind", "Access", "Status"],
      groups.flatMap((g) => g.sources.map((s) => [`\`${s.key}\``, s.name, s.kind, s.accessMethod, s.status])),
    ),
    "",
    "## Details",
    "",
  ];
  for (const g of groups) {
    out.push(`## ${STATUS_TITLE[g.status]}`, "");
    for (const s of g.sources) out.push(detail(s), "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
