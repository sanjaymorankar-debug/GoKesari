/**
 * Dealer commission formula engine ("Formula builder / custom formula").
 *
 * Lets an admin write a commission rule such as
 *   IF(shopsThisMonth >= 50, PERCENT(platformCommissionPaise, 700), PERCENT(platformCommissionPaise, 500))
 * and evaluates it against numbers for one dealer and one event.
 *
 * Safety rules:
 * - A hand-written tokenizer and recursive-descent parser build a small AST,
 *   and a tree-walking evaluator computes it. Nothing here uses `eval`,
 *   `new Function`, `with`, regex-based evaluation or any other dynamic code.
 * - Only the arithmetic, comparison and logic operators and the functions in
 *   FORMULA_FUNCTIONS exist. Variables must be in the caller's whitelist.
 * - The names `__proto__`, `constructor` and `prototype` are refused outright.
 *   Values are read from a null-prototype copy with
 *   `Object.prototype.hasOwnProperty.call`, never `values[name]` on the
 *   caller's object.
 * - Limits: 1000 characters, 200 AST nodes, nesting depth 20. Division by
 *   zero and non-finite results throw FormulaError.
 *
 * Money is in paise; a formula returns paise and callers round. Booleans are
 * 1 and 0. Error positions are 0-based character offsets into the formula.
 */

export const MAX_FORMULA_LENGTH = 1000;
export const MAX_FORMULA_NODES = 200;
export const MAX_FORMULA_DEPTH = 20;

const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Variables a dealer commission formula may use. */
export const DEALER_FORMULA_VARIABLES = [
  { name: "shopRegistrationFeePaise", description: "Registration fee the shop paid, in paise." },
  { name: "shopActivationFeePaise", description: "Activation fee the shop paid, in paise." },
  { name: "platformCommissionPaise", description: "Commission GoKesari earned on the order, in paise." },
  { name: "transactionValuePaise", description: "Gross order value, in paise." },
  { name: "netTransactionValuePaise", description: "Order value after discounts, refunds and taxes, in paise." },
  { name: "shopsThisMonth", description: "Shops the dealer brought in this calendar month." },
  { name: "activeShops", description: "The dealer's shops that are live today." },
  { name: "monthsSinceActivation", description: "Whole months since the shop went live." },
  { name: "dealerRating", description: "The dealer's current rating (for example 0 to 5)." },
] as const;

export type DealerFormulaVariable = (typeof DEALER_FORMULA_VARIABLES)[number]["name"];

export const DEALER_FORMULA_VARIABLE_NAMES: readonly DealerFormulaVariable[] = DEALER_FORMULA_VARIABLES.map(
  (v) => v.name,
);

/** Functions a formula may call, with how many values each takes (maxArgs null = no limit). */
export const FORMULA_FUNCTIONS = [
  { name: "IF", minArgs: 3, maxArgs: 3, signature: "IF(condition, then, else)", description: "Gives 'then' when the condition is true (not 0), otherwise 'else'." },
  { name: "MIN", minArgs: 1, maxArgs: null, signature: "MIN(a, b, ...)", description: "The smallest of the values." },
  { name: "MAX", minArgs: 1, maxArgs: null, signature: "MAX(a, b, ...)", description: "The largest of the values." },
  { name: "ROUND", minArgs: 1, maxArgs: 2, signature: "ROUND(x[, digits])", description: "Rounds half away from zero to 'digits' decimal places (default 0)." },
  { name: "FLOOR", minArgs: 1, maxArgs: 1, signature: "FLOOR(x)", description: "Rounds down to a whole number." },
  { name: "CEIL", minArgs: 1, maxArgs: 1, signature: "CEIL(x)", description: "Rounds up to a whole number." },
  { name: "ABS", minArgs: 1, maxArgs: 1, signature: "ABS(x)", description: "The value without its sign." },
  { name: "CLAMP", minArgs: 3, maxArgs: 3, signature: "CLAMP(x, low, high)", description: "Keeps x between low and high." },
  { name: "PERCENT", minArgs: 2, maxArgs: 2, signature: "PERCENT(base, basisPoints)", description: "base × basisPoints ÷ 10000 (700 = 7%)." },
] as const;

export type FormulaFunctionName = (typeof FORMULA_FUNCTIONS)[number]["name"];

type FunctionSpec = (typeof FORMULA_FUNCTIONS)[number];

const FUNCTION_SPECS: ReadonlyMap<string, FunctionSpec> = new Map(FORMULA_FUNCTIONS.map((f) => [f.name, f]));

export type ComparisonOp = "<" | "<=" | ">" | ">=" | "==" | "!=";
export type BinaryOp = "+" | "-" | "*" | "/" | ComparisonOp | "and" | "or";

export type FormulaNode =
  | { type: "number"; value: number; pos: number }
  | { type: "variable"; name: string; pos: number }
  | { type: "unary"; op: "-" | "not"; operand: FormulaNode; pos: number }
  | { type: "binary"; op: BinaryOp; left: FormulaNode; right: FormulaNode; pos: number }
  | { type: "call"; name: FormulaFunctionName; args: FormulaNode[]; pos: number };

export type ParseResult =
  | { ok: true; ast: FormulaNode; variables: string[] }
  | { ok: false; error: string; position: number };

export type CompileResult =
  | { ok: true; evaluate: (values: Record<string, number>) => number; variables: string[] }
  | { ok: false; error: string; position: number };

/** Thrown by evaluateFormula: missing value, division by zero or a non-finite result. */
export class FormulaError extends Error {
  readonly position: number | null;

  constructor(message: string, position: number | null = null) {
    super(message);
    this.name = "FormulaError";
    this.position = position;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: "number"; value: number; text: string; pos: number }
  | { kind: "ident"; text: string; pos: number }
  | { kind: "op"; text: string; pos: number }
  | { kind: "eof"; text: ""; pos: number };

class ParseFailure extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

const TWO_CHAR_OPS: ReadonlySet<string> = new Set(["<=", ">=", "==", "!="]);
const ONE_CHAR_OPS: ReadonlySet<string> = new Set(["+", "-", "*", "/", "(", ")", ",", "<", ">"]);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    const start = i;
    if (isDigit(ch) || (ch === "." && i + 1 < src.length && isDigit(src[i + 1]))) {
      while (i < src.length && isDigit(src[i])) i += 1;
      if (src[i] === ".") {
        i += 1;
        if (!(i < src.length && isDigit(src[i]))) {
          throw new ParseFailure(`The number at position ${start} ends with a dot; write a digit after it.`, start);
        }
        while (i < src.length && isDigit(src[i])) i += 1;
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new ParseFailure(`The number at position ${start} is too large.`, start);
      }
      tokens.push({ kind: "number", value, text, pos: start });
      continue;
    }
    if (isIdentStart(ch)) {
      while (i < src.length && isIdentPart(src[i])) i += 1;
      tokens.push({ kind: "ident", text: src.slice(start, i), pos: start });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ kind: "op", text: two, pos: start });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(ch)) {
      tokens.push({ kind: "op", text: ch, pos: start });
      i += 1;
      continue;
    }
    if (two === "&&") throw new ParseFailure(`Use 'and' instead of '&&' at position ${start}.`, start);
    if (two === "||") throw new ParseFailure(`Use 'or' instead of '||' at position ${start}.`, start);
    if (ch === "=") throw new ParseFailure(`Use '==' to compare values at position ${start}.`, start);
    if (ch === "!") throw new ParseFailure(`Use 'not' instead of '!' at position ${start}.`, start);
    throw new ParseFailure(`Unexpected character '${ch}' at position ${start}.`, start);
  }
  tokens.push({ kind: "eof", text: "", pos: src.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
//
//   expr    := or
//   or      := and ("or" and)*
//   and     := not ("and" not)*
//   not     := "not" not | compare
//   compare := sum (("<" | "<=" | ">" | ">=" | "==" | "!=") sum)?
//   sum     := product (("+" | "-") product)*
//   product := unary (("*" | "/") unary)*
//   unary   := "-" unary | primary
//   primary := number | name | name "(" [expr ("," expr)*] ")" | "(" expr ")"
// ---------------------------------------------------------------------------

const COMPARISON_OPS: ReadonlySet<string> = new Set(["<", "<=", ">", ">=", "==", "!="]);

function describeToken(token: Token): string {
  if (token.kind === "eof") return "the end of the formula";
  return `'${token.text}' at position ${token.pos}`;
}

function plural(n: number): string {
  return n === 1 ? "value" : "values";
}

class Parser {
  private index = 0;
  private depth = 0;
  private nodes = 0;
  private readonly usedVariables: string[] = [];

  constructor(
    private readonly tokens: Token[],
    private readonly allowed: ReadonlySet<string>,
  ) {}

  parse(): { ast: FormulaNode; variables: string[] } {
    const ast = this.parseOr();
    const next = this.peek();
    if (next.kind !== "eof") {
      throw new ParseFailure(`Unexpected ${describeToken(next)}; the formula should end there.`, next.pos);
    }
    return { ast, variables: [...this.usedVariables] };
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (token.kind !== "eof") this.index += 1;
    return token;
  }

  private isOp(text: string): boolean {
    const token = this.peek();
    return token.kind === "op" && token.text === text;
  }

  private isKeyword(word: string): boolean {
    const token = this.peek();
    return token.kind === "ident" && token.text.toLowerCase() === word;
  }

  private node<T extends FormulaNode>(node: T): T {
    this.nodes += 1;
    if (this.nodes > MAX_FORMULA_NODES) {
      throw new ParseFailure(`The formula is too long: it has more than ${MAX_FORMULA_NODES} parts.`, node.pos);
    }
    return node;
  }

  private enter(pos: number): void {
    this.depth += 1;
    if (this.depth > MAX_FORMULA_DEPTH) {
      throw new ParseFailure(`The formula is nested too deeply (more than ${MAX_FORMULA_DEPTH} levels) at position ${pos}.`, pos);
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  private parseOr(): FormulaNode {
    let left = this.parseAnd();
    while (this.isKeyword("or")) {
      const op = this.next();
      const right = this.parseAnd();
      left = this.node({ type: "binary", op: "or", left, right, pos: op.pos });
    }
    return left;
  }

  private parseAnd(): FormulaNode {
    let left = this.parseNot();
    while (this.isKeyword("and")) {
      const op = this.next();
      const right = this.parseNot();
      left = this.node({ type: "binary", op: "and", left, right, pos: op.pos });
    }
    return left;
  }

  private parseNot(): FormulaNode {
    if (this.isKeyword("not")) {
      const op = this.next();
      this.enter(op.pos);
      const operand = this.parseNot();
      this.leave();
      return this.node({ type: "unary", op: "not", operand, pos: op.pos });
    }
    return this.parseCompare();
  }

  private parseCompare(): FormulaNode {
    const left = this.parseSum();
    const token = this.peek();
    if (token.kind === "op" && COMPARISON_OPS.has(token.text)) {
      this.next();
      const right = this.parseSum();
      const after = this.peek();
      if (after.kind === "op" && COMPARISON_OPS.has(after.text)) {
        throw new ParseFailure(
          `Comparisons cannot be chained at position ${after.pos}; join them with 'and'.`,
          after.pos,
        );
      }
      return this.node({ type: "binary", op: token.text as ComparisonOp, left, right, pos: token.pos });
    }
    return left;
  }

  private parseSum(): FormulaNode {
    let left = this.parseProduct();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next();
      const right = this.parseProduct();
      left = this.node({ type: "binary", op: op.text as "+" | "-", left, right, pos: op.pos });
    }
    return left;
  }

  private parseProduct(): FormulaNode {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = this.next();
      const right = this.parseUnary();
      left = this.node({ type: "binary", op: op.text as "*" | "/", left, right, pos: op.pos });
    }
    return left;
  }

  private parseUnary(): FormulaNode {
    if (this.isOp("-")) {
      const op = this.next();
      this.enter(op.pos);
      const operand = this.parseUnary();
      this.leave();
      return this.node({ type: "unary", op: "-", operand, pos: op.pos });
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaNode {
    const token = this.next();
    if (token.kind === "number") {
      return this.node({ type: "number", value: token.value, pos: token.pos });
    }
    if (token.kind === "op" && token.text === "(") {
      this.enter(token.pos);
      const inner = this.parseOr();
      this.leave();
      if (!this.isOp(")")) {
        throw new ParseFailure(
          `Missing ')' to close the '(' at position ${token.pos}; found ${describeToken(this.peek())}.`,
          this.peek().pos,
        );
      }
      this.next();
      return inner;
    }
    if (token.kind === "ident") {
      return this.parseName(token);
    }
    if (token.kind === "eof") {
      throw new ParseFailure("The formula ends too early; a value is missing at the end.", token.pos);
    }
    throw new ParseFailure(`Unexpected ${describeToken(token)}; a value was expected.`, token.pos);
  }

  private parseName(token: Extract<Token, { kind: "ident" }>): FormulaNode {
    const name = token.text;
    if (FORBIDDEN_NAMES.has(name)) {
      throw new ParseFailure(`The name '${name}' is not allowed (position ${token.pos}).`, token.pos);
    }
    const lower = name.toLowerCase();
    if (lower === "and" || lower === "or" || lower === "not") {
      throw new ParseFailure(`Unexpected '${name}' at position ${token.pos}; a value was expected.`, token.pos);
    }
    if (this.isOp("(")) {
      return this.parseCall(token);
    }
    if (!this.allowed.has(name)) {
      throw new ParseFailure(`Unknown variable '${name}' at position ${token.pos}.`, token.pos);
    }
    if (!this.usedVariables.includes(name)) this.usedVariables.push(name);
    return this.node({ type: "variable", name, pos: token.pos });
  }

  private parseCall(token: Extract<Token, { kind: "ident" }>): FormulaNode {
    const upper = token.text.toUpperCase();
    const spec = FUNCTION_SPECS.get(upper);
    if (!spec) {
      throw new ParseFailure(`Unknown function '${token.text}' at position ${token.pos}.`, token.pos);
    }
    const open = this.next(); // "("
    this.enter(open.pos);
    const args: FormulaNode[] = [];
    if (!this.isOp(")")) {
      for (;;) {
        args.push(this.parseOr());
        if (this.isOp(",")) {
          this.next();
          continue;
        }
        break;
      }
    }
    this.leave();
    if (!this.isOp(")")) {
      throw new ParseFailure(
        `Missing ')' to close ${spec.name}( at position ${open.pos}; found ${describeToken(this.peek())}.`,
        this.peek().pos,
      );
    }
    this.next();
    checkArity(spec, args.length, token.pos);
    return this.node({ type: "call", name: spec.name, args, pos: token.pos });
  }
}

function checkArity(spec: FunctionSpec, got: number, pos: number): void {
  const { name, minArgs, maxArgs } = spec;
  if (maxArgs === null) {
    if (got < minArgs) {
      throw new ParseFailure(`${name} needs at least ${minArgs} ${plural(minArgs)}, got ${got}.`, pos);
    }
    return;
  }
  if (got >= minArgs && got <= maxArgs) return;
  if (minArgs === maxArgs) {
    throw new ParseFailure(`${name} needs ${minArgs} ${plural(minArgs)}, got ${got}.`, pos);
  }
  throw new ParseFailure(`${name} needs ${minArgs} or ${maxArgs} values, got ${got}.`, pos);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parses a formula. Only names in `allowedVariables` may be used as variables. */
export function parseFormula(src: string, allowedVariables: readonly string[]): ParseResult {
  if (typeof src !== "string") {
    return { ok: false, error: "The formula must be text.", position: 0 };
  }
  if (src.length > MAX_FORMULA_LENGTH) {
    return {
      ok: false,
      error: `The formula is too long: ${src.length} characters, the limit is ${MAX_FORMULA_LENGTH}.`,
      position: MAX_FORMULA_LENGTH,
    };
  }
  if (src.trim() === "") {
    return { ok: false, error: "The formula is empty.", position: 0 };
  }
  const allowed = new Set(allowedVariables.filter((name) => !FORBIDDEN_NAMES.has(name)));
  try {
    const tokens = tokenize(src);
    const { ast, variables } = new Parser(tokens, allowed).parse();
    return { ok: true, ast, variables };
  } catch (err) {
    if (err instanceof ParseFailure) {
      return { ok: false, error: err.message, position: err.position };
    }
    throw err;
  }
}

function finite(value: number, pos: number): number {
  if (!Number.isFinite(value)) {
    throw new FormulaError(`The result at position ${pos} is not a finite number.`, pos);
  }
  return value;
}

function shiftDecimal(n: number, digits: number): number {
  const [mantissa, exponent] = n.toExponential().split("e");
  return Number(`${mantissa}e${Number(exponent) + digits}`);
}

function roundHalfAwayFromZero(x: number, digits: number): number {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  if (digits === 0) return sign * Math.round(abs);
  return sign * shiftDecimal(Math.round(shiftDecimal(abs, digits)), -digits);
}

function truthy(n: number): boolean {
  return n !== 0;
}

function bool(b: boolean): number {
  return b ? 1 : 0;
}

/**
 * Evaluates a parsed formula. Throws FormulaError on a missing or non-numeric
 * value, division by zero or a non-finite result.
 */
export function evaluateFormula(ast: FormulaNode, values: Record<string, number>): number {
  const safe: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (values !== null && typeof values === "object") {
    for (const key of Object.keys(values)) {
      if (FORBIDDEN_NAMES.has(key)) continue;
      safe[key] = values[key];
    }
  }

  const lookup = (name: string, pos: number): number => {
    if (FORBIDDEN_NAMES.has(name) || !Object.prototype.hasOwnProperty.call(safe, name)) {
      throw new FormulaError(`No value was given for '${name}'.`, pos);
    }
    const value = safe[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new FormulaError(`The value for '${name}' must be a finite number.`, pos);
    }
    return value;
  };

  const walk = (node: FormulaNode, depth: number): number => {
    if (depth > MAX_FORMULA_NODES) {
      throw new FormulaError("The formula is too large to evaluate.", node.pos);
    }
    switch (node.type) {
      case "number":
        return finite(node.value, node.pos);
      case "variable":
        return lookup(node.name, node.pos);
      case "unary": {
        const v = walk(node.operand, depth + 1);
        return node.op === "-" ? finite(-v, node.pos) : bool(!truthy(v));
      }
      case "binary":
        return binary(node, depth);
      case "call":
        return call(node, depth);
      default:
        throw new FormulaError("The formula contains an unknown part.", null);
    }
  };

  const binary = (node: Extract<FormulaNode, { type: "binary" }>, depth: number): number => {
    if (node.op === "and") {
      return bool(truthy(walk(node.left, depth + 1)) && truthy(walk(node.right, depth + 1)));
    }
    if (node.op === "or") {
      return bool(truthy(walk(node.left, depth + 1)) || truthy(walk(node.right, depth + 1)));
    }
    const a = walk(node.left, depth + 1);
    const b = walk(node.right, depth + 1);
    switch (node.op) {
      case "+":
        return finite(a + b, node.pos);
      case "-":
        return finite(a - b, node.pos);
      case "*":
        return finite(a * b, node.pos);
      case "/":
        if (b === 0) throw new FormulaError(`Division by zero at position ${node.pos}.`, node.pos);
        return finite(a / b, node.pos);
      case "<":
        return bool(a < b);
      case "<=":
        return bool(a <= b);
      case ">":
        return bool(a > b);
      case ">=":
        return bool(a >= b);
      case "==":
        return bool(a === b);
      case "!=":
        return bool(a !== b);
      default:
        throw new FormulaError("The formula contains an unknown operator.", node.pos);
    }
  };

  const call = (node: Extract<FormulaNode, { type: "call" }>, depth: number): number => {
    const arg = (i: number): number => walk(node.args[i], depth + 1);
    const spec = FUNCTION_SPECS.get(node.name);
    if (!spec || !Array.isArray(node.args)) {
      throw new FormulaError("The formula contains an unknown function.", node.pos);
    }
    const n = node.args.length;
    if (n < spec.minArgs || (spec.maxArgs !== null && n > spec.maxArgs)) {
      throw new FormulaError(`${spec.name} has the wrong number of values.`, node.pos);
    }
    switch (node.name) {
      case "IF":
        // Lazy: only the chosen branch runs, so IF(x == 0, 0, y / x) is safe.
        return truthy(arg(0)) ? arg(1) : arg(2);
      case "MIN":
      case "MAX": {
        let result = arg(0);
        for (let i = 1; i < n; i += 1) {
          const v = arg(i);
          result = node.name === "MIN" ? Math.min(result, v) : Math.max(result, v);
        }
        return result;
      }
      case "ROUND": {
        const x = arg(0);
        const digits = n === 2 ? arg(1) : 0;
        if (!Number.isInteger(digits) || digits < -10 || digits > 10) {
          throw new FormulaError("ROUND needs a whole number of digits between -10 and 10.", node.pos);
        }
        return finite(roundHalfAwayFromZero(x, digits), node.pos);
      }
      case "FLOOR":
        return Math.floor(arg(0));
      case "CEIL":
        return Math.ceil(arg(0));
      case "ABS":
        return Math.abs(arg(0));
      case "CLAMP": {
        const x = arg(0);
        const lo = arg(1);
        const hi = arg(2);
        if (lo > hi) {
          throw new FormulaError("CLAMP needs the low limit to be no more than the high limit.", node.pos);
        }
        return Math.min(Math.max(x, lo), hi);
      }
      case "PERCENT":
        return finite((arg(0) * arg(1)) / 10000, node.pos);
      default:
        throw new FormulaError("The formula contains an unknown function.", node.pos);
    }
  };

  const result = walk(ast, 0);
  if (!Number.isFinite(result)) {
    throw new FormulaError("The formula did not give a finite number.", null);
  }
  // Normalise -0 to 0 so callers never store a negative zero.
  return result === 0 ? 0 : result;
}

/** Parses once and returns a reusable evaluator. */
export function compileFormula(src: string, allowedVariables: readonly string[]): CompileResult {
  const parsed = parseFormula(src, allowedVariables);
  if (!parsed.ok) return parsed;
  const { ast, variables } = parsed;
  return { ok: true, evaluate: (values) => evaluateFormula(ast, values), variables };
}

/** Formats a parse failure for display: the message, the formula, and a caret under the position. */
export function describeFormulaError(src: string, failure: { error: string; position: number }): string {
  const position = Math.max(0, Math.min(failure.position, src.length));
  const lineStart = src.lastIndexOf("\n", position - 1) + 1;
  const lineEndRaw = src.indexOf("\n", position);
  const lineEnd = lineEndRaw === -1 ? src.length : lineEndRaw;
  const line = src.slice(lineStart, lineEnd);
  return `${failure.error}\n${line}\n${" ".repeat(position - lineStart)}^`;
}
