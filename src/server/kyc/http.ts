/**
 * Outbound HTTP for verification vendors: a per-attempt timeout, a few
 * retries with exponential backoff and jitter for transient failures, and an
 * idempotency key on every attempt so a retry the vendor already processed is
 * not billed twice (where the vendor honours it).
 *
 * Errors are classified into KycUnavailableError (retry later, document stays
 * PENDING) and KycConfigError (our fault, an admin must look). Request and
 * response bodies are never logged — they carry full document numbers.
 */
import { KycConfigError, KycUnavailableError } from "./types";

export interface KycHttpOptions {
  timeoutMs: number;
  /** Retries after the first attempt. */
  retries: number;
  /** First backoff delay; doubles each retry, plus up to 50% jitter. */
  backoffMs: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface KycHttpResponse {
  status: number;
  body: unknown;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * POSTs JSON and returns the parsed body for any 2xx or 404 (a lookup that
 * found nothing is an answer, not an error). Everything else throws.
 */
export async function kycPostJson(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  idempotencyKey: string,
  options: KycHttpOptions,
): Promise<KycHttpResponse> {
  return kycRequestJson("POST", url, headers, payload, idempotencyKey, options);
}

/**
 * kycPostJson for any method. `answerStatuses` are vendor-specific codes that
 * are answers rather than failures (Sandbox's DigiLocker 521 "no such session"
 * and 523 "session can't be used"): their body is returned instead of retried.
 */
export async function kycRequestJson(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  idempotencyKey: string,
  options: KycHttpOptions,
  answerStatuses: readonly number[] = [],
): Promise<KycHttpResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: KycUnavailableError | null = null;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    if (attempt > 0) {
      const base = options.backoffMs * 2 ** (attempt - 1);
      await sleep(base + Math.floor(Math.random() * base * 0.5));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers: {
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
          Accept: "application/json",
          "Idempotency-Key": idempotencyKey,
          ...headers,
        },
        ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      clearTimeout(timer);
      lastError =
        controller.signal.aborted
          ? new KycUnavailableError("timeout", `Vendor did not answer within ${options.timeoutMs} ms.`)
          : new KycUnavailableError("network", `Could not reach the vendor: ${(error as Error).name}.`);
      continue;
    }
    clearTimeout(timer);

    if (response.status === 401 || response.status === 403 || response.status === 406) {
      // 406 is Gridlines' "IP not whitelisted".
      throw new KycConfigError(
        "auth_failed",
        `Vendor refused our credentials or server address (HTTP ${response.status}).`,
      );
    }
    if (isRetryableStatus(response.status) && !answerStatuses.includes(response.status)) {
      lastError = new KycUnavailableError(
        response.status === 429 ? "rate_limited" : "vendor_error",
        `Vendor returned HTTP ${response.status}.`,
      );
      continue;
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      throw new KycConfigError("unexpected_response", `Vendor returned a non-JSON body (HTTP ${response.status}).`);
    }
    if (response.ok || response.status === 404 || answerStatuses.includes(response.status)) return { status: response.status, body };
    throw new KycConfigError("bad_request", `Vendor rejected the request (HTTP ${response.status}).`);
  }

  throw lastError ?? new KycUnavailableError("vendor_error", "Vendor call failed.");
}

/**
 * Downloads a file the vendor links to (a pre-signed storage URL: no
 * credentials are sent) into memory, at most `maxBytes`. One attempt — the
 * caller decides what a failure means. The bytes are never logged or stored.
 */
export async function kycGetBytes(url: string, options: KycHttpOptions, maxBytes: number): Promise<Buffer> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let response: Response;
    try {
      response = await doFetch(url, { method: "GET", signal: controller.signal, cache: "no-store" });
    } catch (error) {
      throw controller.signal.aborted
        ? new KycUnavailableError("timeout", `Vendor file did not arrive within ${options.timeoutMs} ms.`)
        : new KycUnavailableError("network", `Could not fetch the vendor file: ${(error as Error).name}.`);
    }
    if (isRetryableStatus(response.status)) throw new KycUnavailableError("vendor_error", `Vendor file: HTTP ${response.status}.`);
    if (!response.ok) throw new KycConfigError("bad_request", `Vendor file refused (HTTP ${response.status}).`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new KycConfigError("unexpected_response", `Vendor file is larger than ${maxBytes} bytes.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new KycConfigError("unexpected_response", `Vendor file is larger than ${maxBytes} bytes.`);
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}
