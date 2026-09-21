/**
 * Glue between the product-master services and the app's route conventions.
 */
import { AppError, conflict, notFound, validationFailed } from "@/lib/errors";

import { MASTER_ID } from "./schemas";
import { PromotionError } from "./services/catalogue-bridge";
import { ReviewError } from "./pipeline/review";
import { SourceNotEnabledError } from "./pipeline/run";

/** Validates the {id} of a product route: a MASTER_PRODUCT_ID, never a raw database key. */
export function assertMasterId(id: string): string {
  if (!MASTER_ID.test(id)) throw validationFailed("Product id must look like GKS-PROD-000000001.");
  return id;
}

/** Translates domain errors into the app's AppError vocabulary so route() maps them to the right status. */
export function mapPmdError(e: unknown): unknown {
  if (e instanceof AppError) return e;
  if (e instanceof PromotionError) {
    if (e.code === "NOT_FOUND") return notFound("Product");
    if (e.code === "NOT_ELIGIBLE") return validationFailed(e.message, { reasons: e.reasons });
    return conflict(e.message, { code: e.code, reasons: e.reasons });
  }
  if (e instanceof ReviewError) {
    if (e.code === "NOT_FOUND") return notFound("Review item");
    return conflict(e.message, { code: e.code });
  }
  if (e instanceof SourceNotEnabledError) return conflict(e.message, { source: e.sourceKey, status: e.status });
  return e;
}

export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapPmdError(e);
  }
}
