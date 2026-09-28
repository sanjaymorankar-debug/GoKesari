/**
 * Application error taxonomy.
 *
 * Services throw these; the API layer maps them to HTTP status codes and a safe
 * client-facing message. Raw errors and stack traces never reach the client
 * (requirement §53).
 */

export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "INSUFFICIENT_BALANCE"
  | "PRODUCT_NOT_PURCHASABLE_ONLINE"
  | "OUT_OF_STOCK"
  | "SHOP_NOT_APPROVED"
  | "INVALID_STATE_TRANSITION"
  | "PAYMENT_VERIFICATION_FAILED"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  INSUFFICIENT_BALANCE: 402,
  PRODUCT_NOT_PURCHASABLE_ONLINE: 409,
  OUT_OF_STOCK: 409,
  SHOP_NOT_APPROVED: 409,
  INVALID_STATE_TRANSITION: 409,
  PAYMENT_VERIFICATION_FAILED: 400,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AppErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

/* Convenience constructors, so services read declaratively. */

export const unauthenticated = (msg = "Please sign in to continue.") =>
  new AppError("UNAUTHENTICATED", msg);

export const forbidden = (msg = "You do not have access to do that.") =>
  new AppError("FORBIDDEN", msg);

export const notFound = (what = "Resource") =>
  new AppError("NOT_FOUND", `${what} was not found.`);

export const validationFailed = (
  msg: string,
  details?: Record<string, unknown>,
) => new AppError("VALIDATION_FAILED", msg, details);

export const conflict = (msg: string, details?: Record<string, unknown>) =>
  new AppError("CONFLICT", msg, details);

export const insufficientBalance = (
  requiredPaise: number,
  availablePaise: number,
) =>
  new AppError(
    "INSUFFICIENT_BALANCE",
    "Insufficient wallet balance. Please recharge your wallet.",
    { requiredPaise, availablePaise, shortfallPaise: requiredPaise - availablePaise },
  );

export const notPurchasableOnline = (reason: string) =>
  new AppError("PRODUCT_NOT_PURCHASABLE_ONLINE", reason);

export const outOfStock = (msg = "This product is currently unavailable online.") =>
  new AppError("OUT_OF_STOCK", msg);

export const invalidTransition = (from: string, to: string) =>
  new AppError(
    "INVALID_STATE_TRANSITION",
    `Cannot change status from ${from} to ${to}.`,
    { from, to },
  );

export const paymentVerificationFailed = (
  msg = "We could not verify this payment.",
) => new AppError("PAYMENT_VERIFICATION_FAILED", msg);

/**
 * Normalises anything thrown into a safe client payload. Unknown errors are
 * logged server-side and reported generically so internals never leak.
 */
export function toClientError(error: unknown): {
  status: number;
  body: { error: { code: AppErrorCode; message: string; details?: unknown } };
} {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }

  console.error("[unhandled]", error);
  // Drizzle's "Failed query" hides the driver's reason (auth, TLS, network).
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    console.error(`[unhandled] cause: ${cause.name}: ${cause.message}${code ? ` (code ${String(code)})` : ""}`);
  }
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL",
        message: "Something went wrong. Please try again.",
      },
    },
  };
}

/** Postgres unique-violation code, used to detect idempotency-key collisions. */
export const PG_UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}
