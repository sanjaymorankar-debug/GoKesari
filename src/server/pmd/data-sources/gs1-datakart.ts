/**
 * GS1 India DataKart (batch-2026-10 WS-D, F9.1.2) — verified product data by GTIN.
 *
 * Until GoKesari has a DataKart Premium subscription / a GS1 India Solution
 * Provider agreement (docs/product-data-sources.md), a MOCK answers for a set
 * of test GTINs with realistic records, filed under its own source
 * `gs1_datakart_mock` so mock data can never pass for GS1 data. The mock
 * never runs in production. The real client is a scaffold configured by
 *   GS1_DATAKART_BASE_URL   the API base URL GS1 India gives with the agreement
 *   GS1_DATAKART_API_KEY    the key (sent as a bearer token)
 * and is used as soon as both are set; align `toStaged` with the attribute
 * names of the real response when the API documentation arrives.
 * Rule pmdSources.gs1Enabled (default OFF) switches the source on.
 */
import { getEnv } from "@/lib/env";
import { getRule } from "@/server/services/settings";

import { analyzeGtin, gs1CheckDigit } from "../normalize/identifiers";
import { createRowsAdapter } from "../sources/adapters/rows";
import { standardCodeMapper } from "../services/ingest-api";
import type { SourceDefinition, StagedProduct } from "../types";
import type { BarcodeLookupSource } from "./types";

/** One product as DataKart describes it (GDSN-style attribute names). */
export interface Gs1Record {
  gtin: string;
  productDescription: string;
  brandName: string;
  brandOwnerName: string | null;
  brandOwnerGln: string | null;
  netContent: string | null;
  netContentUom: string | null;
  gpcBrickCode: string | null;
  gpcBrickName: string | null;
  hsnCode: string | null;
  gstRate: number | null;
  mrp: number | null;
  countryOfOrigin: string | null;
  imageUrls: string[];
}

export interface Gs1DataKartClient {
  readonly name: "REAL" | "MOCK";
  isConfigured(): boolean;
  fetchByGtins(gtins14: string[]): Promise<Gs1Record[]>;
}

/* ------------------------------------------------------------------ mock */

const g13 = (body12: string) => body12 + gs1CheckDigit(body12);

/** Test GTINs (GS1 India 890 prefix, valid check digits) and the records the mock returns for them. */
export const GS1_MOCK_RECORDS: readonly Gs1Record[] = [
  {
    gtin: g13("890100100001"), productDescription: "Pasteurised Table Butter 100 g", brandName: "Amul",
    brandOwnerName: "Gujarat Co-operative Milk Marketing Federation Ltd", brandOwnerGln: "8901001000006", netContent: "100", netContentUom: "GRM",
    gpcBrickCode: "10000046", gpcBrickName: "Butter", hsnCode: "04051000", gstRate: 12, mrp: 62, countryOfOrigin: "India",
    imageUrls: ["https://images.example.com/gs1/amul-butter-100g-front.jpg"],
  },
  {
    gtin: g13("890100200002"), productDescription: "Iodised Salt 1 kg", brandName: "Tata Salt",
    brandOwnerName: "Tata Consumer Products Ltd", brandOwnerGln: "8901002000005", netContent: "1", netContentUom: "KGM",
    gpcBrickCode: "10000158", gpcBrickName: "Salt", hsnCode: "25010020", gstRate: 0, mrp: 28, countryOfOrigin: "India",
    imageUrls: ["https://images.example.com/gs1/tata-salt-1kg-front.jpg"],
  },
  {
    gtin: g13("890100300003"), productDescription: "Glucose Biscuits 250 g", brandName: "Parle-G",
    brandOwnerName: "Parle Products Pvt Ltd", brandOwnerGln: "8901003000004", netContent: "250", netContentUom: "GRM",
    gpcBrickCode: "10000045", gpcBrickName: "Biscuits/Cookies", hsnCode: "19053100", gstRate: 18, mrp: 25, countryOfOrigin: "India",
    imageUrls: [],
  },
  {
    gtin: g13("890100400004"), productDescription: "Toned Milk 500 ml Pouch", brandName: "Gokul",
    brandOwnerName: "Kolhapur Zilla Sahakari Dudh Utpadak Sangh Ltd", brandOwnerGln: "8901004000003", netContent: "500", netContentUom: "MLT",
    gpcBrickCode: "10000025", gpcBrickName: "Milk (Perishable)", hsnCode: "04012000", gstRate: 0, mrp: 28, countryOfOrigin: "India",
    imageUrls: [],
  },
];

export class MockGs1DataKartClient implements Gs1DataKartClient {
  readonly name = "MOCK" as const;
  isConfigured(): boolean {
    return true;
  }
  async fetchByGtins(gtins14: string[]): Promise<Gs1Record[]> {
    const wanted = new Set(gtins14);
    return GS1_MOCK_RECORDS.filter((r) => wanted.has(analyzeGtin(r.gtin)!.gtin14));
  }
}

/* ------------------------------------------------------- real (scaffold) */

export class DataKartApiClient implements Gs1DataKartClient {
  readonly name = "REAL" as const;
  constructor(
    private readonly baseUrl: string | undefined = process.env.GS1_DATAKART_BASE_URL ?? getEnv().GS1_DATAKART_BASE_URL,
    private readonly apiKey: string | undefined = process.env.GS1_DATAKART_API_KEY ?? getEnv().GS1_DATAKART_API_KEY,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.baseUrl?.trim() && this.apiKey?.trim());
  }

  async fetchByGtins(gtins14: string[]): Promise<Gs1Record[]> {
    if (!this.isConfigured()) throw new Error("GS1 DataKart is not configured (GS1_DATAKART_BASE_URL / GS1_DATAKART_API_KEY).");
    const out: Gs1Record[] = [];
    for (const gtin of gtins14) {
      // Endpoint shape to confirm with GS1 India's API documentation (Solution Provider agreement).
      const res = await this.fetchFn(`${this.baseUrl!.replace(/\/$/, "")}/products/${encodeURIComponent(gtin)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`GS1 DataKart answered ${res.status}.`);
      const body = (await res.json()) as Partial<Gs1Record> & Record<string, unknown>;
      if (!body.gtin || !body.productDescription || !body.brandName) continue;
      out.push({
        gtin: String(body.gtin),
        productDescription: String(body.productDescription),
        brandName: String(body.brandName),
        brandOwnerName: (body.brandOwnerName as string) ?? null,
        brandOwnerGln: (body.brandOwnerGln as string) ?? null,
        netContent: body.netContent != null ? String(body.netContent) : null,
        netContentUom: (body.netContentUom as string) ?? null,
        gpcBrickCode: (body.gpcBrickCode as string) ?? null,
        gpcBrickName: (body.gpcBrickName as string) ?? null,
        hsnCode: (body.hsnCode as string) ?? null,
        gstRate: typeof body.gstRate === "number" ? body.gstRate : null,
        mrp: typeof body.mrp === "number" ? body.mrp : null,
        countryOfOrigin: (body.countryOfOrigin as string) ?? null,
        imageUrls: Array.isArray(body.imageUrls) ? (body.imageUrls as string[]) : [],
      });
    }
    return out;
  }
}

/* ------------------------------------------------------------ data source */

const UNECE: Record<string, string> = { GRM: "g", KGM: "kg", MLT: "ml", LTR: "l", H87: "pcs", EA: "pcs" };

export function gs1RecordToStaged(r: Gs1Record): StagedProduct {
  const gtin14 = analyzeGtin(r.gtin)?.gtin14 ?? r.gtin;
  return {
    sourceProductId: gtin14,
    name: r.productDescription,
    brand: r.brandName,
    manufacturer: r.brandOwnerName,
    categories: [],
    gtin: gtin14,
    quantityText: r.netContent ? `${r.netContent} ${UNECE[r.netContentUom ?? ""] ?? r.netContentUom ?? ""}`.trim() : null,
    hsnCode: r.hsnCode,
    gstRate: r.gstRate,
    countryOfOrigin: r.countryOfOrigin,
    images: r.imageUrls,
    attributes: [
      ...(r.brandOwnerGln ? [{ key: "brand_owner_gln", value: r.brandOwnerGln }] : []),
      ...(r.gpcBrickCode ? [{ key: "gpc_brick_code", value: r.gpcBrickCode }] : []),
      ...(r.gpcBrickName ? [{ key: "gpc_brick_name", value: r.gpcBrickName }] : []),
    ].filter((a) => KNOWN_GS1_ATTRIBUTES.has(a.key)),
    offer: r.mrp != null ? { mrp: r.mrp, sellerName: r.brandOwnerName ?? r.brandName, currency: "INR" } : null,
  };
}

/** Attribute keys the registry knows (taxonomy/attributes.ts); others are left out rather than rejected. */
const KNOWN_GS1_ATTRIBUTES = new Set<string>(["brand_owner_gln", "gpc_brick_code", "gpc_brick_name"]);

export function gs1Definition(mode: "REAL" | "MOCK"): SourceDefinition {
  return mode === "REAL"
    ? {
        key: "gs1_datakart",
        name: "GS1 India DataKart",
        kind: "GS1",
        accessMethod: "OFFICIAL_API",
        status: "ACTIVE",
        reliability: 95,
        specPrecedence: 5,
        legalBasis:
          "Product data from GS1 India's DataKart under a DataKart Premium subscription / GS1 India Solution Provider agreement; only records whose brand owners have not restricted sharing are delivered. See docs/product-data-sources.md.",
        licenseName: "GS1 India DataKart terms (agreement)",
        termsUrl: "https://www.gs1india.org/wp-content/themes/gs1/assets/images/Terms-Conditions-for-Registering-as-GS1-India-Solution-Provider.pdf",
        authEnvVar: "GS1_DATAKART_API_KEY",
        collectionFrequency: "on demand (barcode look-up)",
        notes: "batch-2026-10 F9.1.2.",
      }
    : {
        key: "gs1_datakart_mock",
        name: "GS1 India DataKart (MOCK — test data)",
        kind: "INTERNAL",
        accessMethod: "MANUAL_UPLOAD",
        status: "ACTIVE",
        reliability: 50,
        specPrecedence: 90,
        legalBasis: "Synthetic test records produced by GoKesari's own mock of the DataKart API, for development and staging only. Not GS1 data.",
        collectionFrequency: "on demand",
        notes: "batch-2026-10 F9.1.2 mock — never runs in production.",
      };
}

export function gs1DataSource(deps: { real?: Gs1DataKartClient; mock?: Gs1DataKartClient; production?: boolean } = {}): BarcodeLookupSource {
  const real = deps.real ?? new DataKartApiClient();
  const mock = deps.mock ?? new MockGs1DataKartClient();
  const production = deps.production ?? process.env.NODE_ENV === "production";
  const mode = (): "REAL" | "MOCK" | "UNAVAILABLE" => (real.isConfigured() ? "REAL" : production ? "UNAVAILABLE" : "MOCK");
  const client = () => (real.isConfigured() ? real : mock);
  const definition = () => gs1Definition(mode() === "REAL" ? "REAL" : "MOCK");
  return {
    get key() {
      return definition().key;
    },
    label: "GS1 India DataKart",
    kind: "GS1",
    definition,
    mode,
    isEnabled: async () => (await getRule("pmdSources")).gs1Enabled && mode() !== "UNAVAILABLE",
    licence: async () =>
      mode() === "REAL"
        ? { name: "GS1 India DataKart (agreement)", url: "https://gs1india.org/datakart/datakart-premium", attribution: "Product data: GS1 India DataKart." }
        : { name: "Test data", url: null, attribution: "MOCK GS1 DataKart record (test data, not from GS1)." },
    adapter: (rows) => createRowsAdapter({ definition: definition(), rows, collectionMethod: mode() === "REAL" ? "OFFICIAL_API" : "MOCK", categoryMapper: standardCodeMapper() }),
    async lookup(gtins) {
      const keys = [...new Set(gtins.map((g) => analyzeGtin(g)).filter((g) => g?.checkDigitValid).map((g) => g!.gtin14))];
      const records = await client().fetchByGtins(keys);
      const found = records.map(gs1RecordToStaged);
      const seen = new Set(found.map((f) => f.gtin));
      return { found, notFound: keys.filter((k) => !seen.has(k)) };
    },
  };
}
