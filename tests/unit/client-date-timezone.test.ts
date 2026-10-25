import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * GAP-017 follow-up: a client component is rendered first on the server
 * (Hostinger, UTC) and then hydrated in the customer's browser (IST). A date
 * formatted without `timeZone` comes out different on the two sides, React
 * logs error #418 and the page can briefly show a UTC time. Every date a
 * "use client" file formats must therefore name its time zone.
 *
 * The check reads the syntax only: toLocaleDateString / toLocaleTimeString
 * always format a date; toLocaleString does when it is called on
 * `new Date(...)` or on a name the file declares as a Date (numbers use it too,
 * e.g. `n.toLocaleString("en-IN")`, and are left alone).
 */

const SRC = path.resolve(__dirname, "../../src");
const DATE_ONLY = new Set(["toLocaleDateString", "toLocaleTimeString"]);

function isUseClient(file: ts.SourceFile): boolean {
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

function isNewDate(node: ts.Expression): boolean {
  const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
  return ts.isNewExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === "Date";
}

function isDateType(type: ts.TypeNode | undefined): boolean {
  return !!type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "Date";
}

/** Names the file declares as a Date: `const d = new Date(...)`, `(d: Date)`, `let d: Date`. */
function dateNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      if (isDateType(node.type) || (node.initializer && isNewDate(node.initializer))) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

function hasTimeZone(options: ts.Expression | undefined): boolean {
  return (
    !!options &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.some(
      (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === "timeZone",
    )
  );
}

/** "line: code" for every date formatted without a time zone in this source. */
export function datesWithoutTimeZone(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (!isUseClient(file)) return [];
  const dates = dateNames(file);
  const found: string[] = [];
  const report = (node: ts.Node) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    found.push(`${line}: ${node.getText(file).split("\n")[0]}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const isDate =
        DATE_ONLY.has(method) ||
        (method === "toLocaleString" && (isNewDate(receiver) || (ts.isIdentifier(receiver) && dates.has(receiver.text))));
      if (isDate && !hasTimeZone(node.arguments[1])) report(node);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Intl" &&
      node.expression.name.text === "DateTimeFormat" &&
      !hasTimeZone(node.arguments?.[1])
    ) {
      report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("client components format dates in India time (GAP-017)", () => {
  it("flags a client date formatted without timeZone, and nothing else", () => {
    const client = `"use client";
      const a = new Date(x).toLocaleString("en-IN");
      const b = new Date(x).toLocaleDateString("en-IN", { dateStyle: "medium" });
      const c = new Date(x).toLocaleTimeString();
      function f(d: Date) { return d.toLocaleString("en-IN", { dateStyle: "short" }); }
      const e = new Intl.DateTimeFormat("en-IN", { day: "numeric" });
      const ok1 = new Date(x).toLocaleString("en-IN", { dateStyle: "short", timeZone: "Asia/Kolkata" });
      const ok2 = row.at.toLocaleDateString("en-IN", {
        day: "numeric",
        timeZone: "Asia/Kolkata",
      });
      const n = (42).toLocaleString("en-IN");
      const total = count.toLocaleString("en-IN", { maximumFractionDigits: 2 });
    `;
    expect(datesWithoutTimeZone("client.tsx", client).map((l) => Number(l.split(":")[0]))).toEqual([2, 3, 4, 5, 6]);
    expect(datesWithoutTimeZone("server.tsx", client.replace('"use client";', ""))).toEqual([]);
  });

  it("every date a client component formats names its time zone", () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      datesWithoutTimeZone(file, readFileSync(file, "utf8")).map((hit) => `${path.relative(SRC, file)}:${hit}`),
    );
    expect(offenders, 'add timeZone: "Asia/Kolkata" to these date calls').toEqual([]);
  });
});
