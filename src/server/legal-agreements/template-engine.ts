/**
 * A small, strict template language for agreement templates (docs/seller-agreements-2026-11).
 *
 *   {{seller.legalName}}          the value, HTML-escaped
 *   {{#if fees.perOrderCommission}} … {{else}} … {{/if}}
 *   {{> licence_schedule}}        a block built in code (tables, signature blocks), per language
 *
 * Strict: a field that is missing, null or empty is never printed as "null" or left blank — it is
 * reported in `missing`, and callers refuse to show or sign a document that has any. Optional text
 * goes inside {{#if}}.
 *
 * Pure (no I/O) so the publish checks, previews and signing all share it and it is unit-tested.
 */

export type TemplateValue = string | number | boolean | null | undefined | TemplateValue[] | { [key: string]: TemplateValue };
export type TemplateData = { [key: string]: TemplateValue };
export type PartialRenderer = (data: TemplateData) => string;

type Node =
  | { kind: "text"; text: string }
  | { kind: "field"; path: string }
  | { kind: "partial"; name: string }
  | { kind: "if"; path: string; then: Node[]; else: Node[] };

const TOKEN = /\{\{\s*(#if\s+[\w.]+|else|\/if|>\s*[\w-]+|[\w.]+)\s*\}\}/g;

export class TemplateSyntaxError extends Error {}

export function parseTemplate(source: string): Node[] {
  const root: Node[] = [];
  const stack: { node: Extract<Node, { kind: "if" }>; inElse: boolean }[] = [];
  const out = () => {
    const top = stack[stack.length - 1];
    return top ? (top.inElse ? top.node.else : top.node.then) : root;
  };
  let last = 0;
  for (const m of source.matchAll(TOKEN)) {
    const index = m.index ?? 0;
    if (index > last) out().push({ kind: "text", text: source.slice(last, index) });
    last = index + m[0].length;
    const token = m[1];
    if (token.startsWith("#if")) {
      const node: Extract<Node, { kind: "if" }> = { kind: "if", path: token.slice(3).trim(), then: [], else: [] };
      out().push(node);
      stack.push({ node, inElse: false });
    } else if (token === "else") {
      const top = stack[stack.length - 1];
      if (!top || top.inElse) throw new TemplateSyntaxError("{{else}} without an open {{#if}}");
      top.inElse = true;
    } else if (token === "/if") {
      if (!stack.pop()) throw new TemplateSyntaxError("{{/if}} without an open {{#if}}");
    } else if (token.startsWith(">")) {
      out().push({ kind: "partial", name: token.slice(1).trim() });
    } else {
      out().push({ kind: "field", path: token });
    }
  }
  if (last < source.length) out().push({ kind: "text", text: source.slice(last) });
  if (stack.length) throw new TemplateSyntaxError(`{{#if ${stack[stack.length - 1].node.path}}} is never closed with {{/if}}`);
  const stray = /\{\{|\}\}/.exec(
    root
      .flatMap(function texts(n: Node): string[] {
        return n.kind === "text" ? [n.text] : n.kind === "if" ? [...n.then.flatMap(texts), ...n.else.flatMap(texts)] : [];
      })
      .join(""),
  );
  if (stray) throw new TemplateSyntaxError("A {{ … }} tag is not understood; use {{field.name}}, {{#if field}}, {{else}}, {{/if}} or {{> block}}.");
  return root;
}

export function lookup(data: TemplateData, path: string): TemplateValue {
  let current: TemplateValue = data;
  for (const key of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, TemplateValue>)[key];
  }
  return current;
}

function isPresent(value: TemplateValue): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export type RenderResult = { html: string; missing: string[]; unknownPartials: string[] };

export function renderTemplate(source: string, data: TemplateData, partials: Record<string, PartialRenderer>): RenderResult {
  const missing = new Set<string>();
  const unknownPartials = new Set<string>();
  const walk = (nodes: Node[]): string =>
    nodes
      .map((node) => {
        switch (node.kind) {
          case "text":
            return node.text;
          case "field": {
            const value = lookup(data, node.path);
            if (!isPresent(value) || typeof value === "object") {
              missing.add(node.path);
              return "";
            }
            return escapeHtml(String(value));
          }
          case "partial": {
            const render = partials[node.name];
            if (!render) {
              unknownPartials.add(node.name);
              return "";
            }
            return render(data);
          }
          case "if":
            return walk(isPresent(lookup(data, node.path)) ? node.then : node.else);
        }
      })
      .join("");
  const html = walk(parseTemplate(source));
  return { html, missing: [...missing].sort(), unknownPartials: [...unknownPartials].sort() };
}

/** Every field, condition and block a template uses (for the admin checks and the translation check). */
export function templateTokens(source: string): { fields: string[]; conditions: string[]; partials: string[] } {
  const fields = new Set<string>();
  const conditions = new Set<string>();
  const partials = new Set<string>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.kind === "field") fields.add(n.path);
      else if (n.kind === "partial") partials.add(n.name);
      else if (n.kind === "if") {
        conditions.add(n.path);
        walk(n.then);
        walk(n.else);
      }
    }
  };
  walk(parseTemplate(source));
  return { fields: [...fields].sort(), conditions: [...conditions].sort(), partials: [...partials].sort() };
}

/**
 * Template HTML may only describe a document: no scripts, event handlers, frames, forms, styles
 * that load resources, or links to other sites' resources. Returns the problems found (empty = OK).
 * The PDF printer and the in-site viewer also run the HTML with scripts and network off; this is
 * the first line, so an admin sees the problem when uploading.
 */
export function unsafeTemplateHtml(source: string): string[] {
  const problems: string[] = [];
  const checks: [RegExp, string][] = [
    [/<\s*(script|iframe|frame|object|embed|form|input|button|link|meta|base|svg|math|video|audio)\b/i, "contains a tag that is not allowed (script, frame, form, link, meta, media, svg …)"],
    [/\son[a-z]+\s*=/i, "contains an event handler attribute (on…=)"],
    [/javascript:/i, "contains a javascript: address"],
    [/\b(src|srcset|background|poster)\s*=\s*["']?\s*(https?:|\/\/)/i, "loads an image or file from another site"],
    [/url\(\s*["']?\s*(https?:|\/\/)/i, "loads a style resource from another site"],
    [/@import/i, "contains @import"],
  ];
  for (const [re, message] of checks) if (re.test(source)) problems.push(message);
  return problems;
}
