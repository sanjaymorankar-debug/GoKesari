/**
 * SOURCE_ADAPTER: the only place marketplace / feed specifics are allowed to live.
 *
 * An adapter turns one source's world into the platform's vocabulary. The core
 * engine (normalise -> match -> validate -> load) never learns a source's field
 * names, URL shapes or quirks, so adding a source means writing an adapter and a
 * registry entry - not touching the engine.
 *
 * Adapters must not bypass anything: no CAPTCHA solving, no authentication
 * workarounds, no ignoring robots.txt. HTTP goes through PoliteHttpClient.
 */
import type { CategoryMapper } from "../taxonomy/mapper";
import type { RawRecord, SourceDefinition, StagedProduct } from "../types";

export interface ExtractContext {
  /** Stop after this many records (pilot runs). */
  limit?: number;
  /** Incremental runs: only records changed after this instant, when the source can tell. */
  since?: Date;
  log: (message: string) => void;
}

/** A record the source gave us that cannot be used. Becomes an IMPORT_ERRORS row; the run continues. */
export class ParseError extends Error {
  /**
   * `WARNING` for a record skipped on purpose by policy (e.g. a per-kilogram price is not a
   * pack price); `ERROR` for a record that should have been usable but was not.
   */
  constructor(public readonly code: string, message: string, public readonly severity: "ERROR" | "WARNING" = "ERROR") {
    super(message);
    this.name = "ParseError";
  }
}

export interface SourceAdapter {
  readonly definition: SourceDefinition;
  /** Recorded on every product_source row, e.g. OPEN_DATASET_CSV, OFFICIAL_API, LICENSED_FEED_CSV. */
  readonly collectionMethod: string;
  /** May this source create new master products, or only enrich/price ones that exist? */
  readonly createsProducts: boolean;
  /**
   * True when one full run lists everything the source has. Only then may a run
   * conclude "not seen this time" (and only ever downgrade offers, never discontinue).
   */
  readonly supportsFullSnapshot: boolean;
  readonly categoryMapper: CategoryMapper;
  /** Shown on stored image links; images are referenced, never copied. */
  readonly imageLicenseNote?: string;

  /** Streams raw records. Must not buffer the whole source in memory. */
  extract(ctx: ExtractContext): AsyncIterable<RawRecord>;
  /** Pure raw -> staged. Throw ParseError for a record that cannot be used. */
  parse(raw: RawRecord): StagedProduct;
  /**
   * Removes personal data (contributor usernames and the like) from the payload BEFORE it is
   * stored in raw_record. The platform collects product facts, never people.
   */
  sanitize?(payload: Record<string, unknown>): Record<string, unknown>;
}

/** Adapters register themselves here so the pipeline can find them by source key. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): this {
    if (this.adapters.has(adapter.definition.key)) throw new Error(`adapter already registered: ${adapter.definition.key}`);
    this.adapters.set(adapter.definition.key, adapter);
    return this;
  }

  get(key: string): SourceAdapter | undefined {
    return this.adapters.get(key);
  }

  keys(): string[] {
    return [...this.adapters.keys()];
  }
}
