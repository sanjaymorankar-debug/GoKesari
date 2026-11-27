/**
 * Pico Xpress HTTP client (docs/pico-xpress-2026-11). The only code that talks to Pico.
 *
 *  - HTTPS to the configured host only (config.ts), 10 s timeout per attempt;
 *  - up to 3 attempts with exponential backoff, and only for network errors and HTTP 5xx — never for a PX_4xx
 *    answer (a refusal is an answer, not an outage);
 *  - success is responseCode "PX_200", whatever the HTTP status says;
 *  - every attempt is written to delivery_partner_api_logs with secrets, phone numbers, OTPs, names and street
 *    addresses masked (mask.ts). The client key (query) and API key (header) are never logged.
 */
import { db } from "@/server/db";
import { deliveryPartnerApiLogs } from "@/server/db/pico-schema";

import { picoConfig, type PicoConfig } from "./config";
import { PicoError, classifyPicoError } from "./errors";
import { maskEndpoint, maskForLog } from "./mask";

export const PICO_PATHS = {
  awbBulk: "/integ/awb/fetch/bulk/v1",
  serviceability: "/integ/order/serviceability/qc",
  create: "/integ/order/create/qc",
  track: "/integ/order/track/qc",
  cancel: "/integ/awb/cancel/v1",
} as const;

export const PICO_TIMEOUT_MS = 10_000;
export const PICO_MAX_ATTEMPTS = 3;

export interface PicoCallOptions {
  method: "GET" | "POST";
  path: (typeof PICO_PATHS)[keyof typeof PICO_PATHS];
  query?: Record<string, string>;
  body?: unknown;
  orderId?: string | null;
  shipmentId?: string | null;
  /** Overrides PICO_MAX_ATTEMPTS (e.g. 1 for a webhook-time pull). */
  attempts?: number;
  /** For tests: no sleeping between attempts. */
  backoffMs?: (attempt: number) => number;
}

export interface PicoEnvelope<T = unknown> {
  response: T;
  responseCode: string;
  responseMessage: string;
}

const defaultBackoff = (attempt: number) => Math.min(4000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100);

async function log(row: typeof deliveryPartnerApiLogs.$inferInsert): Promise<void> {
  try {
    await db.insert(deliveryPartnerApiLogs).values({
      ...row,
      responseMessage: row.responseMessage?.slice(0, 300) ?? null,
      error: row.error?.slice(0, 500) ?? null,
    });
  } catch (error) {
    console.error("[pico] could not write the API log", error instanceof Error ? error.message : error);
  }
}

function requireConfig(): PicoConfig {
  const r = picoConfig();
  if (!r.ok) throw new PicoError("AUTH", r.problem, null, null, false);
  return r.config;
}

/** Calls Pico and returns `response` of a PX_200 answer; throws PicoError otherwise. */
export async function picoCall<T = unknown>(options: PicoCallOptions, config: PicoConfig = requireConfig()): Promise<T> {
  const url = new URL(options.path, config.baseUrl);
  url.searchParams.set("clientKey", config.clientKey);
  for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
  if (url.protocol !== "https:") throw new PicoError("AUTH", "Pico calls must use HTTPS.", null, null, false);
  const loggedEndpoint = maskEndpoint(`${url.pathname}${url.search}`);
  const maskedRequest = options.body === undefined ? null : maskForLog(options.body);
  const maxAttempts = Math.max(1, Math.min(PICO_MAX_ATTEMPTS, options.attempts ?? PICO_MAX_ATTEMPTS));
  const backoff = options.backoffMs ?? defaultBackoff;

  let last: PicoError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PICO_TIMEOUT_MS);
    let httpStatus: number | null = null;
    try {
      const res = await fetch(url, {
        method: options.method,
        headers: {
          Authorization: config.apiKey,
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      httpStatus = res.status;
      const text = await res.text();
      let parsed: Partial<PicoEnvelope<T>> | null = null;
      try {
        parsed = text ? (JSON.parse(text) as Partial<PicoEnvelope<T>>) : null;
      } catch {
        parsed = null;
      }
      const pxCode = typeof parsed?.responseCode === "string" ? parsed.responseCode : null;
      const message = typeof parsed?.responseMessage === "string" ? parsed.responseMessage : "";
      const latencyMs = Date.now() - started;
      if (pxCode === "PX_200") {
        await log({ env: config.env, endpoint: loggedEndpoint, method: options.method, attempt, httpStatus, pxCode, responseMessage: message, ok: "Y", latencyMs, requestBody: maskedRequest, responseBody: maskForLog(parsed?.response ?? null), orderId: options.orderId ?? null, shipmentId: options.shipmentId ?? null });
        return parsed!.response as T;
      }
      const serverError = res.status >= 500;
      const err = pxCode
        ? new PicoError(classifyPicoError(pxCode, message), message || pxCode, pxCode, res.status, false)
        : new PicoError(serverError ? "NETWORK" : "BAD_RESPONSE", `HTTP ${res.status} without a Pico answer`, null, res.status, serverError);
      // An HTTP 5xx without a Pico answer is an outage (retried); any PX_ code is Pico's answer (not retried).
      await log({ env: config.env, endpoint: loggedEndpoint, method: options.method, attempt, httpStatus, pxCode, responseMessage: message, ok: "N", latencyMs, requestBody: maskedRequest, responseBody: maskForLog(parsed ?? { length: text.length }), error: err.message, orderId: options.orderId ?? null, shipmentId: options.shipmentId ?? null });
      if (!err.retryable) throw err;
      last = err;
    } catch (error) {
      if (error instanceof PicoError && !error.retryable) throw error;
      const err =
        error instanceof PicoError
          ? error
          : new PicoError("NETWORK", controller.signal.aborted ? `No answer within ${PICO_TIMEOUT_MS / 1000} s` : "Network error", null, httpStatus, true);
      if (!(error instanceof PicoError)) {
        await log({ env: config.env, endpoint: loggedEndpoint, method: options.method, attempt, httpStatus, pxCode: null, responseMessage: null, ok: "N", latencyMs: Date.now() - started, requestBody: maskedRequest, responseBody: null, error: err.message, orderId: options.orderId ?? null, shipmentId: options.shipmentId ?? null });
      }
      last = err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, backoff(attempt)));
  }
  throw last ?? new PicoError("NETWORK", "Pico did not answer.", null, null, true);
}

/* ------------------------------------------------------------------ endpoints */

/** Doc page 2. Pico allows up to 10,000 per call; we never ask for more than 1,000. */
export async function fetchAwbBatch(count: number): Promise<string[]> {
  const n = Math.max(1, Math.min(1000, Math.floor(count)));
  const res = await picoCall<{ awbList?: unknown }>({ method: "GET", path: PICO_PATHS.awbBulk, query: { awbCount: String(n) } });
  const list = Array.isArray(res?.awbList) ? res.awbList : [];
  return list.map((a) => String(a).trim()).filter((a) => /^[A-Za-z0-9-]{4,40}$/.test(a));
}

export interface ServiceabilityInput {
  orderId: string;
  deliveryLat: number;
  deliveryLng: number;
  pickupLat: number;
  pickupLng: number;
  paymentType: "COD" | "PREPAID";
}

/** Doc page 3. Mandatory before manifestation. */
export async function checkServiceability(input: ServiceabilityInput, ids: { orderId?: string } = {}): Promise<{ serviceable: boolean; message: string | null }> {
  const res = await picoCall<{ serviceable?: unknown; message?: unknown }>(
    { method: "POST", path: PICO_PATHS.serviceability, body: input, orderId: ids.orderId ?? null, attempts: 2 },
  );
  return { serviceable: res?.serviceable === true, message: typeof res?.message === "string" ? res.message : null };
}

/** Doc page 4. */
export async function createPicoOrder(body: Record<string, unknown>, ids: { orderId: string; shipmentId: string }): Promise<{ awbNumber: string | null; message: string | null }> {
  const res = await picoCall<{ awbNumber?: unknown; message?: unknown }>({ method: "POST", path: PICO_PATHS.create, body, orderId: ids.orderId, shipmentId: ids.shipmentId });
  return { awbNumber: typeof res?.awbNumber === "string" ? res.awbNumber : null, message: typeof res?.message === "string" ? res.message : null };
}

/** Doc page 5 (pull). Returns the raw `response` for status.ts to parse. */
export async function trackPico(awbs: string[], ids: { orderId?: string; shipmentId?: string } = {}): Promise<unknown> {
  return picoCall({
    method: "GET",
    path: PICO_PATHS.track,
    query: { awbNumberList: awbs.slice(0, 50).join(","), detailed: "true" },
    orderId: ids.orderId ?? null,
    shipmentId: ids.shipmentId ?? null,
  });
}

/** Doc page 8. Only while Pico has the shipment as DRAFT or CREATED. */
export async function cancelPicoAwb(awbNumber: string, reason: string, ids: { orderId?: string; shipmentId?: string } = {}): Promise<void> {
  await picoCall({
    method: "POST",
    path: PICO_PATHS.cancel,
    body: { awbNumber, reason: reason.slice(0, 200) },
    orderId: ids.orderId ?? null,
    shipmentId: ids.shipmentId ?? null,
    attempts: 2,
  });
}
