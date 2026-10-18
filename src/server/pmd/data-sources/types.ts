/**
 * ProductDataSource (batch-2026-10 WS-D, F9.1.2) — a thin layer ON TOP of the
 * pipeline's SourceAdapter (sources/adapter.ts, unchanged): where product
 * records come from, whether the source may be used right now (a rule flag,
 * plus credentials for an external one), the licence its records carry, and
 * how its records become a SourceAdapter so the existing pipeline stages and
 * de-duplicates them (GTIN-14 identity through match/engine.ts).
 *
 *   manufacturer.ts      the manufacturer self-upload portal (CSV / Excel template + API key)
 *   gs1-datakart.ts      GS1 India DataKart — mock until an agreement and keys exist
 *   open-food-facts.ts   Open Food Facts barcode look-up (ODbL 1.0, attribution stored)
 */
import type { SourceAdapter } from "../sources/adapter";
import type { SourceDefinition, StagedProduct } from "../types";

export interface DataSourceLicence {
  name: string;
  url: string | null;
  /** Shown with every record from the source (product browser) and stored per record. */
  attribution: string | null;
}

export interface ProductDataSource {
  readonly key: string;
  readonly label: string;
  readonly kind: "MANUFACTURER" | "GS1" | "OPEN_DATA";
  /** The pmd.source row its records are filed under. */
  definition(): SourceDefinition;
  /** Rule flag on (and, for an external source, a usable client). */
  isEnabled(): Promise<boolean>;
  licence(): Promise<DataSourceLicence | null>;
  /** Wraps staged rows for the existing ingestion pipeline. */
  adapter(rows: StagedProduct[]): SourceAdapter;
}

/** A source that answers barcode look-ups (GS1 DataKart, Open Food Facts). */
export interface BarcodeLookupSource extends ProductDataSource {
  /** Mock / real / not configured — shown to staff. */
  mode(): "REAL" | "MOCK" | "UNAVAILABLE";
  lookup(gtins: string[]): Promise<{ found: StagedProduct[]; notFound: string[] }>;
}

export class DataSourceDisabledError extends Error {
  constructor(public readonly sourceKey: string, message: string) {
    super(message);
    this.name = "DataSourceDisabledError";
  }
}
