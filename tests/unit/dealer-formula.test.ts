/**
 * Dealer platform P5: the safe formula engine (src/lib/dealer-formula.ts) —
 * grammar, precedence, functions, limits, errors and injection attempts.
 */
import { describe, expect, it } from "vitest";

import {
  compileFormula,
  DEALER_FORMULA_VARIABLE_NAMES,
  DEALER_FORMULA_VARIABLES,
  describeFormulaError,
  evaluateFormula,
  FORMULA_FUNCTIONS,
  FormulaError,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_LENGTH,
  parseFormula,
} from "@/lib/dealer-formula";

const VARS = ["a", "b", "x", ...DEALER_FORMULA_VARIABLE_NAMES];

function run(src: string, values: Record<string, number> = {}): number {
  const compiled = compileFormula(src, VARS);
  if (!compiled.ok) throw new Error(`parse failed: ${compiled.error}`);
  return compiled.evaluate(values);
}

function parseError(src: string, allowed: readonly string[] = VARS): { error: string; position: number } {
  const parsed = parseFormula(src, allowed);
  if (parsed.ok) throw new Error(`expected "${src}" to fail to parse`);
  return parsed;
}

describe("dealer formula: numbers and precedence", () => {
  it("reads integers and decimals", () => {
    expect(run("42")).toBe(42);
    expect(run("3.25")).toBe(3.25);
    expect(run(".5")).toBe(0.5);
  });

  it("follows arithmetic precedence and left associativity", () => {
    expect(run("2+3*4")).toBe(14);
    expect(run("(2+3)*4")).toBe(20);
    expect(run("10-4-3")).toBe(3);
    expect(run("8/4/2")).toBe(1);
    expect(run("-2*3")).toBe(-6);
    expect(run("- -2")).toBe(2);
    expect(run("2 * -3")).toBe(-6);
  });

  it("uses variables from the values", () => {
    expect(run("a * b + x", { a: 2, b: 5, x: 1 })).toBe(11);
  });
});

describe("dealer formula: comparisons and logic", () => {
  it("evaluates comparisons as 1 or 0", () => {
    expect(run("1 < 2")).toBe(1);
    expect(run("2 <= 2")).toBe(1);
    expect(run("1 > 2")).toBe(0);
    expect(run("2 >= 3")).toBe(0);
    expect(run("3 == 3")).toBe(1);
    expect(run("3 != 3")).toBe(0);
    expect(run("1 + 1 == 2")).toBe(1);
  });

  it("evaluates and, or, not (any case)", () => {
    expect(run("1 < 2 and 2 < 3")).toBe(1);
    expect(run("1 > 2 and 2 < 3")).toBe(0);
    expect(run("1 > 2 or 2 < 3")).toBe(1);
    expect(run("not 0")).toBe(1);
    expect(run("not 5")).toBe(0);
    expect(run("NOT 1 > 2 AND 1 OR 0")).toBe(1);
    // "and" binds tighter than "or"
    expect(run("1 or 0 and 0")).toBe(1);
  });

  it("short-circuits and/or", () => {
    expect(run("0 and 1 / 0")).toBe(0);
    expect(run("1 or 1 / 0")).toBe(1);
  });

  it("refuses chained comparisons", () => {
    expect(parseError("1 < 2 < 3").error).toMatch(/cannot be chained/);
  });
});

describe("dealer formula: functions", () => {
  it("IF picks a branch and only evaluates that branch", () => {
    expect(run("IF(1, 10, 20)")).toBe(10);
    expect(run("IF(0, 10, 20)")).toBe(20);
    expect(run("IF(x == 0, 0, 100 / x)", { x: 0 })).toBe(0);
    expect(run("IF(x == 0, 0, 100 / x)", { x: 4 })).toBe(25);
  });

  it("MIN and MAX take any number of values", () => {
    expect(run("MIN(5)")).toBe(5);
    expect(run("MIN(5, 2, 9)")).toBe(2);
    expect(run("MAX(5, 2, 9)")).toBe(9);
    expect(run("MAX(-1, -7)")).toBe(-1);
  });

  it("ROUND rounds half away from zero, with optional digits", () => {
    expect(run("ROUND(2.5)")).toBe(3);
    expect(run("ROUND(-2.5)")).toBe(-3);
    expect(run("ROUND(2.4)")).toBe(2);
    expect(run("ROUND(1.005, 2)")).toBe(1.01);
    expect(run("ROUND(1234, -2)")).toBe(1200);
    expect(() => run("ROUND(1.5, 0.5)")).toThrow(FormulaError);
  });

  it("FLOOR, CEIL and ABS", () => {
    expect(run("FLOOR(2.7)")).toBe(2);
    expect(run("CEIL(2.1)")).toBe(3);
    expect(run("ABS(-4)")).toBe(4);
  });

  it("CLAMP keeps a value between limits", () => {
    expect(run("CLAMP(5, 0, 10)")).toBe(5);
    expect(run("CLAMP(-5, 0, 10)")).toBe(0);
    expect(run("CLAMP(50, 0, 10)")).toBe(10);
    expect(() => run("CLAMP(5, 10, 0)")).toThrow(/low limit/);
  });

  it("PERCENT works in basis points", () => {
    expect(run("PERCENT(10000, 700)")).toBe(700);
    expect(run("PERCENT(25000, 250)")).toBe(625);
  });

  it("function names are case-insensitive", () => {
    expect(run("if(1, 2, 3)")).toBe(2);
    expect(run("Max(1, 4)")).toBe(4);
    expect(run("percent(10000, 100)")).toBe(100);
    expect(run("rOuNd(2.6)")).toBe(3);
  });

  it("FORMULA_FUNCTIONS lists every function with its arity", () => {
    const names = FORMULA_FUNCTIONS.map((f) => f.name);
    expect(names).toEqual(["IF", "MIN", "MAX", "ROUND", "FLOOR", "CEIL", "ABS", "CLAMP", "PERCENT"]);
    expect(FORMULA_FUNCTIONS.find((f) => f.name === "MIN")?.maxArgs).toBeNull();
    expect(FORMULA_FUNCTIONS.find((f) => f.name === "ROUND")).toMatchObject({ minArgs: 1, maxArgs: 2 });
  });
});

describe("dealer formula: parse errors", () => {
  it("names an unknown variable and its position", () => {
    const err = parseError("1 + fee");
    expect(err.error).toBe("Unknown variable 'fee' at position 4.");
    expect(err.position).toBe(4);
  });

  it("names an unknown function", () => {
    expect(parseError("SQRT(4)").error).toBe("Unknown function 'SQRT' at position 0.");
  });

  it("reports wrong argument counts", () => {
    expect(parseError("IF(1, 2)").error).toBe("IF needs 3 values, got 2.");
    expect(parseError("ABS(1, 2)").error).toBe("ABS needs 1 value, got 2.");
    expect(parseError("ROUND(1, 2, 3)").error).toBe("ROUND needs 1 or 2 values, got 3.");
    expect(parseError("MIN()").error).toBe("MIN needs at least 1 value, got 0.");
  });

  it("rejects trailing garbage", () => {
    expect(parseError("1 + 2 3").error).toMatch(/Unexpected '3' at position 6/);
    expect(parseError("2abc").position).toBe(1);
  });

  it("rejects unbalanced parentheses", () => {
    expect(parseError("(1 + 2").error).toMatch(/Missing '\)'/);
    expect(parseError("1 + 2)").error).toMatch(/Unexpected '\)' at position 5/);
    expect(parseError("MAX(1, 2").error).toMatch(/Missing '\)' to close MAX\(/);
  });

  it("rejects an empty formula", () => {
    expect(parseError("").error).toBe("The formula is empty.");
    expect(parseError("   ").error).toBe("The formula is empty.");
  });

  it("rejects incomplete expressions", () => {
    expect(parseError("1 +").error).toMatch(/ends too early/);
    expect(parseError("1.").error).toMatch(/ends with a dot/);
  });

  it("rejects a formula over the length limit", () => {
    const src = `${"1+".repeat(MAX_FORMULA_LENGTH / 2)}1`;
    expect(src.length).toBeGreaterThan(MAX_FORMULA_LENGTH);
    expect(parseError(src).error).toMatch(/too long: 1001 characters/);
  });

  it("rejects nesting deeper than the limit", () => {
    const ok = `${"(".repeat(MAX_FORMULA_DEPTH)}1${")".repeat(MAX_FORMULA_DEPTH)}`;
    expect(parseFormula(ok, VARS).ok).toBe(true);
    const deep = `${"(".repeat(MAX_FORMULA_DEPTH + 1)}1${")".repeat(MAX_FORMULA_DEPTH + 1)}`;
    expect(parseError(deep).error).toMatch(/nested too deeply/);
    expect(parseError(`${"ABS(".repeat(25)}1${")".repeat(25)}`).error).toMatch(/nested too deeply/);
    expect(parseError(`${"-".repeat(25)}1`).error).toMatch(/nested too deeply/);
  });

  it("rejects more than 200 nodes", () => {
    // 100 numbers + 99 operators = 199 nodes: fine.
    expect(parseFormula(Array(100).fill("1").join("+"), VARS).ok).toBe(true);
    // 101 numbers + 100 operators = 201 nodes: too many.
    expect(parseError(Array(101).fill("1").join("+")).error).toMatch(/more than 200 parts/);
  });

  it("suggests the right operator for common mistakes", () => {
    expect(parseError("a = 1").error).toMatch(/Use '=='/);
    expect(parseError("a && b").error).toMatch(/Use 'and'/);
    expect(parseError("a || b").error).toMatch(/Use 'or'/);
    expect(parseError("!a").error).toMatch(/Use 'not'/);
  });

  it("lists the variables a formula uses, once each", () => {
    const parsed = parseFormula("a + b * a", VARS);
    expect(parsed.ok && parsed.variables).toEqual(["a", "b"]);
  });

  it("describeFormulaError points at the position", () => {
    const err = parseError("1 + fee");
    expect(describeFormulaError("1 + fee", err)).toBe("Unknown variable 'fee' at position 4.\n1 + fee\n    ^");
  });
});

describe("dealer formula: evaluation errors", () => {
  it("throws FormulaError on division by zero", () => {
    expect(() => run("1 / 0")).toThrow(FormulaError);
    expect(() => run("a / (b - b)", { a: 1, b: 2 })).toThrow(/Division by zero/);
  });

  it("throws FormulaError when a value is missing", () => {
    expect(() => run("a + b", { a: 1 })).toThrow("No value was given for 'b'.");
  });

  it("throws FormulaError on a non-finite or non-number value", () => {
    expect(() => run("a", { a: Number.NaN })).toThrow(/finite number/);
    expect(() => run("a", { a: Number.POSITIVE_INFINITY })).toThrow(FormulaError);
    expect(() => run("a", { a: "5" as unknown as number })).toThrow(/finite number/);
  });

  it("throws FormulaError when the result overflows", () => {
    const big = "9".repeat(300);
    expect(() => run(`${big} * ${big} * ${big}`)).toThrow(FormulaError);
  });

  it("does not read inherited properties from the values object", () => {
    const values = Object.create({ a: 5 }) as Record<string, number>;
    expect(() => run("a", values)).toThrow("No value was given for 'a'.");
  });

  it("returns 0, never -0", () => {
    expect(Object.is(run("-0"), 0)).toBe(true);
  });
});

describe("dealer formula: injection attempts fail to parse", () => {
  const attempts = [
    "constructor",
    "__proto__",
    "prototype",
    "a.constructor",
    "constructor(1)",
    "process.exit()",
    "process.exit(1)",
    "a; b",
    "`a`",
    "${a}",
    "'a'",
    "\"a\"",
    "a[0]",
    "globalThis",
    "require(1)",
    "Function(1)",
    "eval(1)",
    "a => a",
    "{}",
    "x + 1",
  ];

  for (const src of attempts) {
    it(`refuses ${JSON.stringify(src)}`, () => {
      expect(parseFormula(src, VARS).ok).toBe(false);
    });
  }

  it("refuses forbidden names even when the whitelist includes them", () => {
    const allowed = ["__proto__", "constructor", "prototype"];
    for (const name of allowed) {
      expect(parseError(name, allowed).error).toBe(`The name '${name}' is not allowed (position 0).`);
    }
  });
});

describe("dealer formula: commission scheme", () => {
  const src =
    "IF(shopsThisMonth >= 50, PERCENT(platformCommissionPaise, 700), PERCENT(platformCommissionPaise, 500))";

  it("parses with the dealer variables", () => {
    const parsed = parseFormula(src, DEALER_FORMULA_VARIABLE_NAMES);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.variables).toEqual(["shopsThisMonth", "platformCommissionPaise"]);
  });

  it("pays 7% at 50+ shops and 5% below", () => {
    const compiled = compileFormula(src, DEALER_FORMULA_VARIABLE_NAMES);
    if (!compiled.ok) throw new Error(compiled.error);
    expect(compiled.evaluate({ shopsThisMonth: 50, platformCommissionPaise: 200000 })).toBe(14000);
    expect(compiled.evaluate({ shopsThisMonth: 49, platformCommissionPaise: 200000 })).toBe(10000);
  });

  it("evaluateFormula works on a stored AST", () => {
    const parsed = parseFormula(src, DEALER_FORMULA_VARIABLE_NAMES);
    if (!parsed.ok) throw new Error(parsed.error);
    const ast = JSON.parse(JSON.stringify(parsed.ast)) as typeof parsed.ast;
    expect(evaluateFormula(ast, { shopsThisMonth: 60, platformCommissionPaise: 1000 })).toBe(70);
  });

  it("DEALER_FORMULA_VARIABLES describes every variable", () => {
    expect(DEALER_FORMULA_VARIABLES.map((v) => v.name)).toEqual([
      "shopRegistrationFeePaise",
      "shopActivationFeePaise",
      "platformCommissionPaise",
      "transactionValuePaise",
      "netTransactionValuePaise",
      "shopsThisMonth",
      "activeShops",
      "monthsSinceActivation",
      "dealerRating",
    ]);
    for (const v of DEALER_FORMULA_VARIABLES) expect(v.description.length).toBeGreaterThan(5);
  });
});
