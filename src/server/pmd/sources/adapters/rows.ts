/**
 * Rows adapter: records that are ALREADY in the platform's staged vocabulary.
 *
 * Used by POST /products/import (an operator supplies JSON rows), by the mapped CSV
 * adapter (which maps a partner's columns into these rows), and by the test-suite.
 * It has no network access and no source-specific quirks.
 */
import { createCategoryMapper, type CategoryMapper } from "../../taxonomy/mapper";
import type { RawRecord, SourceDefinition, StagedProduct } from "../../types";
import { ParseError, type SourceAdapter } from "../adapter";

export interface RowsAdapterOptions {
  definition: SourceDefinition;
  rows: StagedProduct[];
  /** True if these rows are the source's COMPLETE listing (absence then downgrades offers). */
  fullSnapshot?: boolean;
  createsProducts?: boolean;
  collectionMethod?: string;
  categoryMapper?: CategoryMapper;
  imageLicenseNote?: string;
}

export function createRowsAdapter(opts: RowsAdapterOptions): SourceAdapter {
  return {
    definition: opts.definition,
    collectionMethod: opts.collectionMethod ?? "MANUAL_UPLOAD_JSON",
    createsProducts: opts.createsProducts ?? true,
    supportsFullSnapshot: opts.fullSnapshot ?? false,
    categoryMapper: opts.categoryMapper ?? createCategoryMapper({ tags: {}, keywords: [] }),
    imageLicenseNote: opts.imageLicenseNote,

    async *extract(ctx): AsyncGenerator<RawRecord> {
      let n = 0;
      for (const row of opts.rows) {
        yield { sourceProductId: String(row.sourceProductId), payload: row as unknown as Record<string, unknown> };
        if (ctx.limit && ++n >= ctx.limit) return;
      }
    },

    parse(raw): StagedProduct {
      const p = raw.payload as unknown as StagedProduct;
      if (!p || typeof p !== "object" || !p.sourceProductId) throw new ParseError("NO_SOURCE_ID", "Row has no sourceProductId.");
      return p;
    },
  };
}
