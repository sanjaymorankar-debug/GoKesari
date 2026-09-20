/**
 * The generated reference documents must match the code they describe.
 * If this fails, run `npm run pmd:docs` and commit the result.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { renderDataDictionary, renderSourceRegister } from "@/server/pmd/docs/render";
import { DATA_SHEETS, SHEET_ORDER } from "@/server/pmd/export/model";
import { SOURCE_REGISTRY } from "@/server/pmd/sources/registry";

const doc = (name: string) => readFileSync(join(process.cwd(), "docs", "product-master", name), "utf8");

describe("generated documentation", () => {
  it("DATA_DICTIONARY.md is up to date with the workbook model", () => {
    expect(doc("DATA_DICTIONARY.md")).toBe(renderDataDictionary());
  });

  it("SOURCE_REGISTER.md is up to date with the source registry", () => {
    expect(doc("SOURCE_REGISTER.md")).toBe(renderSourceRegister());
  });

  it("the data dictionary covers every sheet and every field", () => {
    const md = renderDataDictionary();
    for (const name of SHEET_ORDER) expect(md, name).toContain(`. ${name}\n`);
    for (const sheet of DATA_SHEETS) for (const c of sheet.columns) expect(md, `${sheet.name}.${c.header}`).toContain(`\`${c.header}\``);
  });

  it("openapi.yaml documents exactly the routes that exist - no more, no fewer", () => {
    const root = join(process.cwd(), "src", "app", "api", "product-master");
    const onDisk = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name === "route.ts") {
          const path = "/" + relative(root, dir).split(sep).join("/").replace(/\[(\w+)\]/g, "{$1}");
          for (const m of readFileSync(full, "utf8").matchAll(/^export const (GET|POST|PUT|PATCH|DELETE)\b/gm)) onDisk.add(`${m[1]} ${path}`);
        }
      }
    };
    walk(root);

    const documented = new Set<string>();
    let path: string | null = null;
    for (const line of doc("openapi.yaml").split("\n")) {
      const p = /^ {2}(\/\S*):\s*$/.exec(line);
      if (p) path = p[1];
      const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
      if (m && path) documented.add(`${m[1].toUpperCase()} ${path}`);
    }
    expect([...documented].sort()).toEqual([...onDisk].sort());
    expect(onDisk.size).toBeGreaterThanOrEqual(15);
  });

  it("every link between the documents resolves (file and #anchor)", () => {
    const dir = join(process.cwd(), "docs", "product-master");
    const slug = (heading: string) =>
      heading.replace(/[`*]/g, "").trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const anchors = (file: string): Set<string> =>
      new Set([...readFileSync(file, "utf8").matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1])));

    const broken: string[] = [];
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(join(dir, name), "utf8").replace(/```[\s\S]*?```/g, ""); // links inside code blocks are examples
      for (const m of text.matchAll(/\]\((?!https?:|mailto:)([^)\s#]*)(?:#([^)\s]*))?\)/g)) {
        const [, target, anchor] = m;
        const file = target ? join(dir, target) : join(dir, name);
        try {
          statSync(file);
        } catch {
          broken.push(`${name}: ${target} does not exist`);
          continue;
        }
        if (anchor && file.endsWith(".md") && !anchors(file).has(anchor)) broken.push(`${name}: ${target || "(same file)"}#${anchor} has no such heading`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("the source register lists every source with its legal basis", () => {
    const md = renderSourceRegister();
    for (const s of SOURCE_REGISTRY) {
      expect(md, s.key).toContain(`\`${s.key}\``);
      expect(md, `${s.key} legal basis`).toContain(s.legalBasis);
    }
  });
});
