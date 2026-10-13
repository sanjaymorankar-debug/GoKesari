/** The split's verification report (docs/db-split-2026-10), as Markdown. */
import type { OrphanRow, VerifyRow } from "./tools";

export function renderReport(input: { verify: VerifyRow[]; orphans: OrphanRow[]; source: string; seller: string; customer: string; at: string }): string {
  const bad = input.verify.filter((v) => !v.ok);
  const broken = input.orphans.filter((o) => o.orphans > 0);
  const lines = [
    `# Seller / customer split — verification report`,
    ``,
    `- When: ${input.at}`,
    `- Source: ${input.source}`,
    `- Seller database: ${input.seller}`,
    `- Customer database: ${input.customer}`,
    `- Tables checked: ${input.verify.length} (${input.verify.filter((v) => v.side === "seller").length} seller, ${input.verify.filter((v) => v.side === "customer").length} customer/core)`,
    `- Rows: ${input.verify.reduce((n, v) => n + v.sourceRows, 0)} in the source, ${input.verify.reduce((n, v) => n + v.targetRows, 0)} in the targets`,
    `- **Result: ${bad.length === 0 && broken.length === 0 ? "PASS — every row copied, every checksum equal, no broken cross-database link" : `FAIL — ${bad.length} table(s) differ, ${broken.length} cross-database link(s) broken`}**`,
    ``,
    `## Row counts and checksums`,
    ``,
    `| Table | Database | Source rows | Target rows | Checksum match |`,
    `|---|---|---:|---:|---|`,
    ...input.verify.map((v) => `| ${v.table} | ${v.side} | ${v.sourceRows} | ${v.targetRows} | ${v.ok ? "yes" : `**NO** (${v.sourceChecksum} vs ${v.targetChecksum})`} |`),
    ``,
    `## Cross-database links (enforced in the service layer)`,
    ``,
    `| Child | Column | → Parent | Direction | Distinct values | Missing parents |`,
    `|---|---|---|---|---:|---:|`,
    ...input.orphans.map((o) => `| ${o.child} | ${o.columns.join(", ")} | ${o.parent} | ${o.childSide} → ${o.parentSide} | ${o.checkedValues} | ${o.orphans === 0 ? "0" : `**${o.orphans}**`} |`),
    ``,
  ];
  return lines.join("\n");
}
