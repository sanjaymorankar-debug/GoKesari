/**
 * Product Master Data Platform - source layer: robots.txt compliance, the streaming
 * delimited parser, and the polite HTTP client.
 *
 * The robots fixtures are the real files served by the Open*Facts hosts, checked
 * when this platform was designed - the tests prove the platform refuses the
 * paths those files disallow and reaches the official bulk dumps they allow.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { gs1CheckDigit } from "@/server/pmd/normalize/identifiers";
import { createCsvFeedAdapter, createTabularFeedAdapter, mapFeedRow, restoreGtin, validateFeedMapping } from "@/server/pmd/sources/adapters/csv-feed";
import { GS1_MAPPING, MANUFACTURER_CATALOGUE_MAPPING } from "@/server/pmd/sources/registry";
import { parseXlsxWithHeader, XlsxReadError } from "@/server/pmd/sources/xlsx";
import { ParseError } from "@/server/pmd/sources/adapter";
import { getSourceDefinition } from "@/server/pmd/sources/registry";
import { DelimitedParseError, parseDelimited, parseDelimitedWithHeader } from "@/server/pmd/sources/delimited";
import { HttpError, PoliteHttpClient, RobotsDisallowedError } from "@/server/pmd/sources/http";
import { isAllowed, parseRobots, RobotsGuard } from "@/server/pmd/sources/robots";

const UA = "GokesariProductMaster/0.1 (+mailto:data@example.com)";

const OFF_ROBOTS = `User-agent: *
Disallow: /api
Disallow: /cgi
Disallow: /facets

User-agent: Googlebot
Disallow: /api
Disallow: /cgi
Allow: /cgi/product_image.pl

User-agent: meta-externalagent/1.1
Disallow: /
`;
const SEARCH_ROBOTS = "User-agent: *\nDisallow: /\n";

describe("robots.txt parsing and matching", () => {
  const off = parseRobots(OFF_ROBOTS);

  it("refuses the API paths Open Food Facts disallows for generic crawlers", () => {
    expect(isAllowed(off, UA, "/api/v2/search?countries_tags_en=india")).toBe(false);
    expect(isAllowed(off, UA, "/cgi/search.pl")).toBe(false);
    expect(isAllowed(off, UA, "/facets/countries")).toBe(false);
  });

  it("allows the official bulk-data dumps", () => {
    expect(isAllowed(off, UA, "/data/en.openfoodfacts.org.products.csv.gz")).toBe(true);
    expect(isAllowed(off, UA, "/data/openbeautyfacts-products.jsonl.gz")).toBe(true);
  });

  it("obeys a blanket Disallow: /", () => {
    expect(isAllowed(parseRobots(SEARCH_ROBOTS), UA, "/search?q=milk")).toBe(false);
  });

  it("an empty robots.txt allows everything", () => {
    expect(isAllowed(parseRobots(""), UA, "/anything")).toBe(true);
  });

  it("the longest matching rule wins and Allow beats Disallow on a tie", () => {
    const r = parseRobots("User-agent: *\nDisallow: /shop\nAllow: /shop/public\nDisallow: /tie\nAllow: /tie\n");
    expect(isAllowed(r, UA, "/shop/private")).toBe(false);
    expect(isAllowed(r, UA, "/shop/public/item")).toBe(true);
    expect(isAllowed(r, UA, "/tie")).toBe(true);
  });

  it("supports * wildcards and $ anchors", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.json$\nDisallow: /tmp*/private\n");
    expect(isAllowed(r, UA, "/x/y.json")).toBe(false);
    expect(isAllowed(r, UA, "/x/y.json5")).toBe(true);
    expect(isAllowed(r, UA, "/tmp123/private")).toBe(false);
  });

  it("prefers the group naming our product token over *", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: gokesariproductmaster\nAllow: /\n");
    expect(isAllowed(r, UA, "/x")).toBe(true);
    expect(isAllowed(r, "OtherBot/1.0", "/x")).toBe(false);
  });

  it("ignores comments and an empty Disallow value", () => {
    const r = parseRobots("# hi\nUser-agent: * # everyone\nDisallow: # nothing\n");
    expect(isAllowed(r, UA, "/x")).toBe(true);
  });
});

describe("RobotsGuard - fails closed", () => {
  const guard = (status: number, text = "", throwError = false) => {
    let calls = 0;
    const g = new RobotsGuard(
      async () => {
        calls++;
        if (throwError) throw new Error("ECONNRESET");
        return { status, text };
      },
      { now: () => 0 },
    );
    return { g, calls: () => calls };
  };

  it("obeys a 200 robots.txt", async () => {
    const { g } = guard(200, OFF_ROBOTS);
    expect((await g.check("https://world.openfoodfacts.org/api/v2/search", UA)).allowed).toBe(false);
    expect((await g.check("https://world.openfoodfacts.org/data/x.csv.gz", UA)).allowed).toBe(true);
  });

  it("treats 404 as 'no robots file' -> allowed", async () => {
    expect((await guard(404).g.check("https://example.com/p", UA)).allowed).toBe(true);
  });

  it.each([401, 403, 429, 500, 503])("treats HTTP %d as disallow-all", async (status) => {
    const d = await guard(status).g.check("https://example.com/p", UA);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/robots/);
  });

  it("treats a network error as disallow-all", async () => {
    const d = await guard(0, "", true).g.check("https://example.com/p", UA);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/failing closed/);
  });

  it("caches per origin", async () => {
    const { g, calls } = guard(200, "User-agent: *\nDisallow:\n");
    await g.check("https://example.com/a", UA);
    await g.check("https://example.com/b", UA);
    await g.check("https://other.example.com/a", UA);
    expect(calls()).toBe(2);
  });

  it("reports the crawl delay", async () => {
    const d = await guard(200, "User-agent: *\nCrawl-delay: 4\n").g.check("https://example.com/a", UA);
    expect(d.crawlDelaySeconds).toBe(4);
  });
});

/* -------------------------------------------------------- delimited parser */

async function* chunked(text: string, size: number): AsyncGenerator<Buffer> {
  const buf = Buffer.from(text, "utf8");
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}
async function collect(gen: AsyncIterable<string[]>): Promise<string[][]> {
  const out: string[][] = [];
  for await (const r of gen) out.push(r);
  return out;
}

describe("streaming delimited parser", () => {
  it("parses TSV with LF and CRLF endings and skips blank lines", async () => {
    const rows = await collect(parseDelimited(chunked("a\tb\tc\r\n1\t2\t3\n\n4\t5\t6", 64)));
    expect(rows).toEqual([["a", "b", "c"], ["1", "2", "3"], ["4", "5", "6"]]);
  });

  it("handles quoted fields with delimiters, newlines and doubled quotes", async () => {
    const rows = await collect(parseDelimited(chunked('"he said ""hi""\nthere"\tx\n"a\tb"\ty\n', 64)));
    expect(rows).toEqual([['he said "hi"\nthere', "x"], ["a\tb", "y"]]);
  });

  it('treats a quote inside an unquoted field as literal text (12" pizza)', async () => {
    const rows = await collect(parseDelimited(chunked('12" pizza\tx\nab"c\ty\n', 64)));
    expect(rows).toEqual([['12" pizza', "x"], ['ab"c', "y"]]);
  });

  it("gives the same result however the input is chunked, including 1 byte at a time", async () => {
    const text = 'name\tqty\n"Amul, ""Taaza""\nMilk"\t1 L\nअमूल दूध\t500 ml\nplain\t"x"\n';
    const whole = await collect(parseDelimited(chunked(text, 10_000)));
    for (const size of [1, 2, 3, 7]) {
      expect(await collect(parseDelimited(chunked(text, size))), `chunk size ${size}`).toEqual(whole);
    }
    expect(whole[2]).toEqual(["अमूल दूध", "500 ml"]);
  });

  it("reads a doubled quote that is split across two chunks", async () => {
    async function* two(): AsyncGenerator<string> {
      yield '"a"';
      yield '"b"\tx\n';
    }
    expect(await collect(parseDelimited(two()))).toEqual([['a"b', "x"]]);
  });

  it("supports other delimiters", async () => {
    expect(await collect(parseDelimited(chunked("a,b\n1,2\n", 64), { delimiter: "," }))).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("fails loudly on an unterminated quote instead of swallowing the file", async () => {
    await expect(collect(parseDelimited(chunked('a\t"never closed\nmore\n', 64)))).rejects.toBeInstanceOf(DelimitedParseError);
  });

  it("keys rows by header and reports (does not pad) rows of the wrong width", async () => {
    const bad: number[] = [];
    const out: Record<string, string>[] = [];
    for await (const r of parseDelimitedWithHeader(chunked("code\tname\n1\tMilk\n2\n3\tButter\n", 8), { onBadRow: (n) => bad.push(n) })) out.push(r);
    expect(out).toEqual([{ code: "1", name: "Milk" }, { code: "3", name: "Butter" }]);
    expect(bad).toEqual([3]);
  });
});

/* -------------------------------------------------------- polite HTTP client */

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const path = new URL(url).pathname;
    const route = routes[url] ?? routes[path];
    if (!route) return new Response("not found", { status: 404 });
    return route();
  }) as typeof fetch;
  return { impl, calls };
}

function client(routes: Record<string, () => Response>, extra: Partial<ConstructorParameters<typeof PoliteHttpClient>[0]> = {}) {
  const f = fakeFetch(routes);
  const sleeps: number[] = [];
  const c = new PoliteHttpClient({
    userAgent: UA,
    fetchImpl: f.impl,
    sleep: async (ms) => void sleeps.push(ms),
    now: () => 0,
    random: () => 0,
    minIntervalMs: 1000,
    baseBackoffMs: 1000,
    ...extra,
  });
  return { c, ...f, sleeps };
}

const ok = (body = "ok") => () => new Response(body, { status: 200 });
const status = (s: number, headers: Record<string, string> = {}) => () => new Response("", { status: s, headers });

describe("PoliteHttpClient", () => {
  it("refuses a user-agent that does not identify us with a contact", () => {
    expect(() => new PoliteHttpClient({ userAgent: "Mozilla/5.0" })).toThrow(/contact/);
  });

  it("never fetches a path robots.txt disallows", async () => {
    const { c, calls } = client({ "/robots.txt": ok(OFF_ROBOTS), "/api/v2/search": ok("secret") });
    await expect(c.get("https://world.openfoodfacts.org/api/v2/search")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual(["/robots.txt"]);
  });

  it("fetches an allowed path and identifies itself", async () => {
    const { c, calls } = client({ "/robots.txt": ok(OFF_ROBOTS), "/data/x.csv": ok("data") });
    const res = await c.get("https://static.example.org/data/x.csv");
    expect(await res.text()).toBe("data");
    expect(calls.at(-1)!.headers["user-agent"]).toBe(UA);
  });

  it("re-checks robots on every redirect hop", async () => {
    const { c, calls } = client({
      "/robots.txt": ok(OFF_ROBOTS),
      "/start": () => new Response("", { status: 302, headers: { location: "/api/leak" } }),
      "/api/leak": ok("leaked"),
    });
    await expect(c.get("https://static.example.org/start")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(calls.some((x) => x.url.endsWith("/api/leak"))).toBe(false);
  });

  it("retries transient failures with exponential backoff, then succeeds", async () => {
    let n = 0;
    const { c, sleeps } = client({
      "/robots.txt": ok(""),
      "/flaky": () => (++n < 3 ? new Response("", { status: 503 }) : new Response("fine", { status: 200 })),
    }, { minIntervalMs: 0 });
    const res = await c.get("https://example.com/flaky");
    expect(await res.text()).toBe("fine");
    expect(sleeps.filter((s) => s >= 1000)).toEqual([1000, 2000]);
  });

  it("honours Retry-After on 429", async () => {
    let n = 0;
    const { c, sleeps } = client({
      "/robots.txt": ok(""),
      "/limited": () => (++n < 2 ? new Response("", { status: 429, headers: { "retry-after": "7" } }) : new Response("ok")),
    }, { minIntervalMs: 0 });
    await c.get("https://example.com/limited");
    expect(Math.max(...sleeps)).toBe(7000);
  });

  it("gives up after maxRetries with a clear error instead of looping", async () => {
    const { c, calls } = client({ "/robots.txt": ok(""), "/down": status(500) }, { maxRetries: 2, minIntervalMs: 0 });
    await expect(c.get("https://example.com/down")).rejects.toMatchObject({ name: "HttpError", status: 500 });
    expect(calls.filter((x) => x.url.endsWith("/down"))).toHaveLength(3);
  });

  it("does not retry a 404", async () => {
    const { c, calls } = client({ "/robots.txt": ok(""), "/missing": status(404) }, { minIntervalMs: 0 });
    const res = await c.get("https://example.com/missing");
    expect(res.status).toBe(404);
    expect(calls.filter((x) => x.url.endsWith("/missing"))).toHaveLength(1);
  });

  it("rate-limits requests to one host", async () => {
    const { c, sleeps } = client({ "/robots.txt": ok(""), "/a": ok(), "/b": ok() });
    await c.get("https://example.com/a");
    await c.get("https://example.com/b");
    expect(sleeps).toContain(1000);
  });

  it("stops reading once the byte cap is reached (never pulls more than asked)", async () => {
    const big = "x".repeat(10_000);
    const { c } = client({ "/robots.txt": ok(""), "/big": () => new Response(big) });
    const res = await c.get("https://example.com/big");
    let got = 0;
    let limited = false;
    for await (const chunk of c.streamBody(res, { maxBytes: 2_000, onLimit: () => (limited = true) })) got += chunk.length;
    expect(limited).toBe(true);
    expect(got).toBeLessThanOrEqual(2_000);
  });

  it("surfaces HttpError from getJson on a non-2xx response", async () => {
    const { c } = client({ "/robots.txt": ok(""), "/bad": status(403) }, { minIntervalMs: 0 });
    await expect(c.getJson("https://example.com/bad")).rejects.toBeInstanceOf(HttpError);
  });
});

describe("mapped CSV feed adapter", () => {
  const MAPPING = {
    sourceProductId: "SKU", name: "Title", brand: "Brand", gtin: "EAN", categories: "Category", images: "Images",
    "offer.price": "Price", "offer.mrp": "MRP", "offer.sellerName": "Seller", "attribute.ram_gb": "RAM",
  };
  const def = getSourceDefinition("partner_feed")!;
  const collect = async (adapter: ReturnType<typeof createCsvFeedAdapter>, limit?: number) => {
    const out = [];
    for await (const r of adapter.extract({ limit, log: () => {} })) out.push(r);
    return out;
  };
  const withFile = async <T,>(csv: string, fn: (path: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), "pmd-feed-"));
    const path = join(dir, "feed.csv");
    writeFileSync(path, csv);
    try {
      return await fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("maps columns to platform fields: scalars, lists, the offer and category-specific attributes", () => {
    const staged = mapFeedRow(
      { SKU: " A-1 ", Title: "Acme Rice 1 kg", Brand: "Acme", EAN: "8901234000014", Category: "Rice|Staples", Images: "https://x.test/1.jpg | https://x.test/2.jpg",
        Price: "189", MRP: "210", Seller: "Acme Retail", RAM: "8", Ignored: "not mapped" },
      MAPPING,
    );
    expect(staged).toMatchObject({
      sourceProductId: "A-1", name: "Acme Rice 1 kg", brand: "Acme", gtin: "8901234000014",
      categories: ["Rice", "Staples"], images: ["https://x.test/1.jpg", "https://x.test/2.jpg"],
      offer: { price: "189", mrp: "210", sellerName: "Acme Retail" }, attributes: [{ key: "ram_gb", value: "8" }],
    });
    expect(staged).not.toHaveProperty("Ignored");
  });

  it("treats empty cells as missing (null), never as an empty string or zero", () => {
    const staged = mapFeedRow({ SKU: "A-2", Title: "  ", Brand: "", EAN: "", Category: "", Images: "", Price: "", MRP: "", Seller: "", RAM: "" }, MAPPING);
    expect(staged).toMatchObject({ name: null, brand: null, gtin: null, categories: [], images: [] });
    expect(staged).not.toHaveProperty("offer");
    expect(staged).not.toHaveProperty("attributes");
  });

  it("rejects a row without an id, and a mapping that does not name the id column", () => {
    expect(() => mapFeedRow({ SKU: "", Title: "x" }, MAPPING)).toThrow(ParseError);
    expect(() => mapFeedRow({ SKU: "", Title: "x" }, MAPPING)).toThrow(/source-id column "SKU"/);
    expect(() => createCsvFeedAdapter({ definition: def, input: { rows: [] }, mapping: { name: "Title" } })).toThrow(/sourceProductId/);
  });

  it("never loses a row: id-less and malformed rows come out as records that parse() rejects", async () => {
    const csv = ["SKU,Title,Brand", "A-1,Good one,Acme", ",No id here,Acme", "A-3,Too,many,cells", "A-4,Last one,Acme", ""].join("\n");
    await withFile(csv, async (path) => {
      const adapter = createCsvFeedAdapter({ definition: def, input: { path }, mapping: { sourceProductId: "SKU", name: "Title", brand: "Brand" } });
      const records = await collect(adapter);
      expect(records.map((r) => r.sourceProductId).sort()).toEqual(["A-1", "A-4", "row-3", "row-4"]);
      const outcome = records.map((r) => {
        try {
          adapter.parse(r);
          return `${r.sourceProductId}: ok`;
        } catch (e) {
          return `${r.sourceProductId}: ${(e as ParseError).code}`;
        }
      }).sort();
      expect(outcome).toEqual(["A-1: ok", "A-4: ok", "row-3: NO_SOURCE_ID", "row-4: ROW_WIDTH"]);
    });
  });

  it("reports file row numbers (header = row 1) and honours the delimiter and the limit", async () => {
    await withFile("SKU;Title\nA-1;One\nA-2;Two\n;Third\nA-4;Four\n", async (path) => {
      const adapter = createCsvFeedAdapter({ definition: def, input: { path }, delimiter: ";", mapping: { sourceProductId: "SKU", name: "Title" } });
      expect((await collect(adapter)).map((r) => r.sourceProductId)).toEqual(["A-1", "A-2", "row-4", "A-4"]);
      expect(await collect(adapter, 2)).toHaveLength(2);
    });
  });

  it("declares itself a licensed-feed adapter that never claims a full snapshot unless told to", () => {
    const a = createCsvFeedAdapter({ definition: def, input: { rows: [] }, mapping: MAPPING });
    expect(a).toMatchObject({ collectionMethod: "LICENSED_FEED_CSV", createsProducts: true, supportsFullSnapshot: false });
    expect(createCsvFeedAdapter({ definition: def, input: { rows: [] }, mapping: MAPPING, fullSnapshot: true }).supportsFullSnapshot).toBe(true);
  });
});

describe("feed mapping: constants, templates, unit codes, typos, lost zeros", () => {
  it("a value can be a =constant or a {template}; |unece turns GS1 unit codes into symbols", () => {
    const staged = mapFeedRow(
      { SKU: "1", Title: "Tea", "Net Content": "500", UoM: "GRM", Vol: "", VolUoM: "" },
      { sourceProductId: "SKU", name: "Title", brand: "=Acme Tea Co", quantityText: "{Net Content} {UoM|unece}", netWeightText: "{Vol} {VolUoM|unece}" },
    );
    expect(staged).toMatchObject({ brand: "Acme Tea Co", quantityText: "500 g", netWeightText: null });
    const other = mapFeedRow({ SKU: "1", N: "2", U: "ZZZ" }, { sourceProductId: "SKU", quantityText: "{N} {U|unece}" });
    expect(other.quantityText).toBe("2 ZZZ"); // an unknown code passes through rather than vanishing
  });

  it("restores the leading zero Excel strips from a UPC-A, and nothing riskier", () => {
    const upc = "01234567890" + gs1CheckDigit("01234567890");
    const stripped = upc.replace(/^0+/, "");
    expect(stripped).toHaveLength(11);
    expect(restoreGtin(stripped)).toBe(upc);
    expect(restoreGtin(upc)).toBe(upc); // already whole
    expect(restoreGtin(stripped.slice(0, -1) + ((Number(stripped.slice(-1)) + 1) % 10))).toBe(stripped.slice(0, -1) + ((Number(stripped.slice(-1)) + 1) % 10)); // wrong check digit: left alone
    expect(restoreGtin("1234567")).toBe("1234567"); // could be a truncated GTIN-8 or an internal number: never guessed
    expect(restoreGtin("ABC12345678")).toBe("ABC12345678");
  });

  it("rejects a mapping key the platform does not know, with the closest valid key", () => {
    const unknown = validateFeedMapping({ sourceProductId: "SKU", gtn: "EAN", "offer.prise": "P", "attribute.ram_gb": "R", name: "T" });
    expect(unknown).toEqual([{ key: "gtn", suggestion: "gtin" }, { key: "offer.prise", suggestion: "offer.price" }]);
    const def = getSourceDefinition("partner_feed")!;
    expect(() => createTabularFeedAdapter({ definition: def, input: { rows: [] }, mapping: { sourceProductId: "SKU", gtn: "EAN" } })).toThrow(/"gtn" \(did you mean "gtin"\?\)/);
  });

  it("the shipped GS1 and manufacturer templates are valid mappings", () => {
    expect(validateFeedMapping(GS1_MAPPING)).toEqual([]);
    expect(validateFeedMapping(MANUFACTURER_CATALOGUE_MAPPING)).toEqual([]);
  });
});

describe("streaming .xlsx reader", () => {
  const withWorkbook = async <T,>(build: (wb: ExcelJS.Workbook) => void, fn: (path: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), "pmd-xlsx-"));
    const path = join(dir, "catalogue.xlsx");
    const wb = new ExcelJS.Workbook();
    build(wb);
    await wb.xlsx.writeFile(path);
    try {
      return await fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const collect = async (path: string, opts?: Parameters<typeof parseXlsxWithHeader>[1]) => {
    const out = [];
    for await (const r of parseXlsxWithHeader(path, opts)) out.push(r);
    return out;
  };
  const collectMode = async (path: string, mode: "stream" | "memory") => {
    const out = [];
    for await (const r of parseXlsxWithHeader(path, {}, mode)) out.push(r);
    return out;
  };

  it("finds the heading row, converts every cell type to text, skips blank rows, reports sheet row numbers", async () => {
    await withWorkbook(
      (wb) => {
        const ws = wb.addWorksheet("Catalogue");
        ws.addRow(["Acme Foods - price list"]);
        ws.addRow([]);
        ws.addRow(["Item", "EAN", "Name", "Launched", "Total", "Note", "Link", "", "Gone"]);
        ws.addRow(["A-1", 8901234000014, "Basmati Rice", new Date(Date.UTC(2026, 8, 1)), { formula: "1+1", result: 2 }, { richText: [{ text: "Long " }, { text: "grain" }] }, { text: "site", hyperlink: "https://x.test" }, "ignored", { error: "#N/A" }]);
        ws.addRow([]);
        ws.addRow(["A-2", 12345678905, "Poha", null, null, null, null, null, null]);
      },
      async (path) => {
        const rows = await collect(path, { headerRow: 3 });
        expect(rows.map((r) => r.rowNumber)).toEqual([4, 6]);
        expect(rows[0].row).toEqual({ Item: "A-1", EAN: "8901234000014", Name: "Basmati Rice", Launched: "2026-09-01", Total: "2", Note: "Long grain", Link: "site", Gone: "" });
        expect(rows[1].row.EAN).toBe("12345678905");
      },
    );
  });

  it("falls back to reading in memory when ExcelJS's streaming reader fails on the file's layout", async () => {
    await withWorkbook(
      (wb) => {
        const ws = wb.addWorksheet("Catalogue");
        ws.addRow(["Item", "Name"]);
        for (let i = 1; i <= 50; i++) ws.addRow([`I-${i}`, `Product ${i}`]);
      },
      async (path) => {
        // Whether ExcelJS's stream reader copes with its OWN output depends on the runtime (it fails on Windows and not on
        // Linux), so the failure it produces on a sheets-before-workbook layout is simulated instead of relied on.
        const spy = vi.spyOn(ExcelJS.stream.xlsx, "WorkbookReader").mockImplementation(function () {
          throw new TypeError("Cannot read properties of undefined (reading 'sheets')");
        } as never);
        try {
          await expect(collectMode(path, "stream")).rejects.toThrow(TypeError);
          expect(await collect(path)).toHaveLength(50); // the default path falls back and still loads every row
        } finally {
          spy.mockRestore();
        }
        expect(await collectMode(path, "memory")).toHaveLength(50);
      },
    );
  });

  it("streams a file whose workbook part comes first, as Excel and LibreOffice write it", async () => {
    await withWorkbook(
      (wb) => {
        const ws = wb.addWorksheet("Catalogue");
        ws.addRow(["Item", "Name"]);
        for (let i = 1; i <= 50; i++) ws.addRow([`I-${i}`, `Product ${i}`]);
      },
      async (path) => {
        const zip = await JSZip.loadAsync(readFileSync(path));
        const first = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml", "xl/styles.xml"];
        const ordered = new JSZip();
        for (const name of [...first, ...Object.keys(zip.files).filter((n) => !first.includes(n))]) {
          const f = zip.file(name);
          if (f) ordered.file(name, await f.async("nodebuffer"));
        }
        writeFileSync(path, await ordered.generateAsync({ type: "nodebuffer" }));
        const streamed = await collectMode(path, "stream");
        expect(streamed).toHaveLength(50);
        expect(streamed[49].row).toEqual({ Item: "I-50", Name: "Product 50" });
      },
    );
  });

  it("chooses a sheet by name or position, and skips a hidden first sheet by default", async () => {
    await withWorkbook(
      (wb) => {
        const hidden = wb.addWorksheet("Internal");
        hidden.state = "hidden";
        hidden.addRow(["X"]);
        hidden.addRow(["secret"]);
        const a = wb.addWorksheet("Front");
        a.addRow(["Item"]);
        a.addRow(["front-1"]);
        const b = wb.addWorksheet("Back");
        b.addRow(["Item"]);
        b.addRow(["back-1"]);
      },
      async (path) => {
        expect((await collect(path))[0].row.Item).toBe("front-1");
        expect((await collect(path, { sheet: "back" }))[0].row.Item).toBe("back-1");
        expect((await collect(path, { sheet: 3 }))[0].row.Item).toBe("back-1");
        await expect(collect(path, { sheet: "Nope" })).rejects.toThrow(/Sheets in the file: Internal \(hidden\), Front, Back/);
        await expect(collect(path, { headerRow: 9 })).rejects.toBeInstanceOf(XlsxReadError);
      },
    );
  });

  it("feeds the same mapping as a CSV: a numeric GTIN that lost its zero comes out whole", async () => {
    const def = getSourceDefinition("partner_feed")!;
    const upc = "01234567890" + gs1CheckDigit("01234567890");
    await withWorkbook(
      (wb) => {
        const ws = wb.addWorksheet("Sheet1");
        ws.addRow(["SKU", "EAN", "Title", "MRP"]);
        ws.addRow(["P-1", Number(upc), "Acme Poha 500 g", 45]);
        ws.addRow(["", 1, "No id", 1]);
      },
      async (path) => {
        const adapter = createTabularFeedAdapter({ definition: def, input: { path }, mapping: { sourceProductId: "SKU", gtin: "EAN", name: "Title", "offer.mrp": "MRP" } });
        expect(adapter.collectionMethod).toBe("LICENSED_FEED_XLSX");
        const records: { sourceProductId: string; payload: Record<string, unknown> }[] = [];
        for await (const r of adapter.extract({ log: () => {} })) records.push(r);
        expect(records.map((r) => r.sourceProductId)).toEqual(["P-1", "row-3"]);
        expect(adapter.parse(records[0])).toMatchObject({ gtin: upc, name: "Acme Poha 500 g", offer: { mrp: "45" } });
        expect(() => adapter.parse(records[1])).toThrow(/source-id column/);
      },
    );
  });
});
