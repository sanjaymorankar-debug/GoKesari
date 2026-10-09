/**
 * Integration errors in words a shop owner can act on (Module 2). Each
 * adapter throws IntegrationError with a code from this catalogue; the sync
 * log and error screen show `message` and `fix`, support sees `detail`.
 * `retryable` decides whether the job is tried again (with backoff) or waits
 * for the owner to fix something and press Retry.
 */
export interface ErrorInfo {
  message: string;
  fix: string;
  retryable: boolean;
}

export const INTEGRATION_ERRORS = {
  NOT_CONFIGURED: {
    message: "The connection is not set up completely.",
    fix: "Open Shop settings → Integrations and fill in the missing details.",
    retryable: false,
  },
  AUTH_FAILED: {
    message: "Your accounting software did not accept GoKesari's login.",
    fix: "Check the API key or reconnect from Shop settings → Integrations.",
    retryable: false,
  },
  TOKEN_EXPIRED: {
    message: "The connection to your accounting software has expired.",
    fix: "Press Reconnect in Shop settings → Integrations.",
    retryable: false,
  },
  UNREACHABLE: {
    message: "Your accounting software could not be reached.",
    fix: "We will keep trying. If it continues, check that the software's address is right and that it is online.",
    retryable: true,
  },
  RATE_LIMITED: {
    message: "Your accounting software asked us to slow down.",
    fix: "Nothing to do — we will try again shortly.",
    retryable: true,
  },
  CONNECTOR_OFFLINE: {
    message: "The GoKesari Connector on your shop computer is not running.",
    fix: "Turn on the shop computer and make sure the GoKesari Connector is running. Waiting entries are sent as soon as it is back.",
    retryable: true,
  },
  TALLY_NOT_RUNNING: {
    message: "Tally is not open on your shop computer.",
    fix: "Open TallyPrime with your company loaded and keep the GoKesari Connector running.",
    retryable: true,
  },
  TALLY_COMPANY_NOT_OPEN: {
    message: "The company set for GoKesari is not open in Tally.",
    fix: "Open the company in Tally, or correct the company name in Shop settings → Integrations.",
    retryable: true,
  },
  LEDGER_MISSING: {
    message: "A ledger GoKesari needs does not exist in your software.",
    fix: "Create the ledger named in the details (or change the name in Shop settings → Integrations), then press Retry.",
    retryable: false,
  },
  ITEM_NOT_MAPPED: {
    message: "A product in this bill is not matched to an item in your software.",
    fix: "Match it on the Item matching screen, then press Retry.",
    retryable: false,
  },
  TAX_NOT_MAPPED: {
    message: "No tax in your software matches this GST rate.",
    fix: "Create the GST tax for this rate in your software (or choose it in Shop settings → Integrations), then press Retry.",
    retryable: false,
  },
  REJECTED: {
    message: "Your accounting software refused this entry.",
    fix: "Read the details below; correct the entry in the software or in GoKesari, then press Retry.",
    retryable: false,
  },
  DUPLICATE_NUMBER: {
    message: "A different entry already uses this number in your software.",
    fix: "Change the number series in your software or contact GoKesari support.",
    retryable: false,
  },
  PRICE_ABOVE_MRP: {
    message: "The price in your software is above the product's MRP, so it was not applied.",
    fix: "Correct the price (or report a wrong MRP from the product page).",
    retryable: false,
  },
  FILE_UNREADABLE: {
    message: "The file could not be read.",
    fix: "Export the file again from your software as Excel (.xlsx) or CSV and upload it.",
    retryable: false,
  },
  INTERNAL: {
    message: "Something went wrong on GoKesari's side.",
    fix: "We will try again. If it keeps happening, contact GoKesari support.",
    retryable: true,
  },
} as const satisfies Record<string, ErrorInfo>;

export type IntegrationErrorCode = keyof typeof INTEGRATION_ERRORS;

export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly detail: string | null;
  readonly retryable: boolean;

  constructor(code: IntegrationErrorCode, detail?: string | null, options: { retryable?: boolean } = {}) {
    super(INTEGRATION_ERRORS[code].message);
    this.name = "IntegrationError";
    this.code = code;
    this.detail = detail ?? null;
    this.retryable = options.retryable ?? INTEGRATION_ERRORS[code].retryable;
  }
}

/** Any thrown value as an IntegrationError (network failures are retryable). */
export function asIntegrationError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|AbortError|timeout/i.test(text)) {
    return new IntegrationError("UNREACHABLE", text);
  }
  return new IntegrationError("INTERNAL", text);
}

export function describeError(code: string | null | undefined): ErrorInfo {
  return (code && (INTEGRATION_ERRORS as Record<string, ErrorInfo>)[code]) || INTEGRATION_ERRORS.INTERNAL;
}
