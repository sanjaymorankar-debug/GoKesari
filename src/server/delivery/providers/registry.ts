/**
 * Delivery Integration Gateway (docs/hdms-2026-11): the only way core code reaches a delivery partner.
 * Every call goes through `callProvider`, which adds
 *  - a per-call timeout (provider.timeout_ms),
 *  - controlled retries for retryable failures (timeouts, 5xx) with backoff — booking is safe to retry
 *    because the adapter sends our idempotency key,
 *  - a circuit breaker (rule deliveryAllocation.circuitFailureThreshold / circuitCooldownSeconds),
 *  - a small per-provider rate limit,
 *  - one delivery_api_logs row per attempt (Integration health page).
 * Credentials are stored AES-256-GCM encrypted (integrations/credentials.ts) and never leave the server.
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { deliveryApiLogs, deliveryProviders, type DeliveryProvider, type DeliveryProviderCode } from "@/server/db/hdms-schema";
import { decryptCredentials } from "@/server/integrations/credentials";
import { getRule } from "@/server/services/settings";

import { mockAdapter } from "./mock";
import { borzoAdapter, pidgeAdapter, porterAdapter, shadowfaxAdapter } from "./partners";
import { picoAdapter } from "./pico";
import { ProviderError, type DeliveryProviderAdapter, type ProviderContext } from "./types";

const ADAPTERS: Record<DeliveryProviderCode, DeliveryProviderAdapter> = {
  SHADOWFAX: shadowfaxAdapter,
  PIDGE: pidgeAdapter,
  PORTER: porterAdapter,
  BORZO: borzoAdapter,
  MOCK: mockAdapter,
  PICO: picoAdapter,
};

export function adapterFor(code: string): DeliveryProviderAdapter | null {
  return (ADAPTERS as Record<string, DeliveryProviderAdapter>)[code] ?? null;
}

export function contextFor(provider: DeliveryProvider): ProviderContext {
  let credentials: Record<string, unknown> = {};
  if (provider.credentialsEncrypted) {
    try {
      credentials = decryptCredentials(provider.credentialsEncrypted);
    } catch {
      throw new ProviderError(`${provider.name}: stored credentials cannot be read (encryption key changed?).`, "NOT_CONFIGURED", false);
    }
  }
  return {
    code: provider.code,
    environment: provider.environment,
    baseUrl: provider.baseUrl,
    credentials,
    timeoutMs: provider.timeoutMs,
  };
}

export function webhookSecretFor(provider: DeliveryProvider): string | null {
  if (!provider.webhookSecretEncrypted) return null;
  try {
    const v = decryptCredentials(provider.webhookSecretEncrypted).secret;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/** Is the partner usable right now (enabled, integrated, circuit closed or cooled down)? */
export function circuitAllows(provider: DeliveryProvider, cooldownSeconds: number, now = Date.now()): boolean {
  if (provider.circuitState !== "OPEN") return true;
  return !provider.circuitOpenedAt || now - provider.circuitOpenedAt.getTime() >= cooldownSeconds * 1000;
}

// Rate limit: at most RATE_PER_SECOND calls per provider per second, per server process.
const RATE_PER_SECOND = 20;
const windows = new Map<string, { second: number; count: number }>();
function takeToken(code: string): boolean {
  const second = Math.floor(Date.now() / 1000);
  const w = windows.get(code);
  if (!w || w.second !== second) {
    windows.set(code, { second, count: 1 });
    return true;
  }
  if (w.count >= RATE_PER_SECOND) return false;
  w.count += 1;
  return true;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError(`${label} timed out after ${ms} ms.`, "TIMEOUT", true)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function logCall(row: typeof deliveryApiLogs.$inferInsert): Promise<void> {
  try {
    await db.insert(deliveryApiLogs).values({ ...row, error: row.error?.slice(0, 500) ?? null });
  } catch (error) {
    console.error("[delivery-gateway] could not log API call", error);
  }
}

async function recordOutcome(provider: DeliveryProvider, ok: boolean, error: string | null, threshold: number): Promise<void> {
  const now = new Date();
  if (ok) {
    await db
      .update(deliveryProviders)
      .set({ consecutiveFailures: 0, circuitState: "CLOSED", circuitOpenedAt: null, lastSuccessAt: now, updatedAt: now })
      .where(eq(deliveryProviders.code, provider.code));
    return;
  }
  await db
    .update(deliveryProviders)
    .set({
      consecutiveFailures: sql`${deliveryProviders.consecutiveFailures} + 1`,
      circuitState: sql`CASE WHEN ${deliveryProviders.consecutiveFailures} + 1 >= ${threshold} THEN 'OPEN' ELSE ${deliveryProviders.circuitState} END`,
      circuitOpenedAt: sql`CASE WHEN ${deliveryProviders.consecutiveFailures} + 1 >= ${threshold} THEN now() ELSE ${deliveryProviders.circuitOpenedAt} END`,
      lastError: error?.slice(0, 500) ?? null,
      lastErrorAt: now,
      updatedAt: now,
    })
    .where(eq(deliveryProviders.code, provider.code));
}

export interface CallOptions {
  operation: "quote" | "book" | "track" | "cancel";
  bookingId?: string | null;
  /** Retries after the first attempt, for retryable failures only. */
  retries?: number;
  /** Overrides the provider's own timeout (e.g. the overall quote budget). */
  timeoutMs?: number;
}

export async function callProvider<T>(
  provider: DeliveryProvider,
  options: CallOptions,
  run: (adapter: DeliveryProviderAdapter, ctx: ProviderContext) => Promise<T>,
): Promise<T> {
  const adapter = adapterFor(provider.code);
  if (!adapter) throw new ProviderError(`No adapter for ${provider.code}.`, "NOT_CONFIGURED", false);
  if (!adapter.integrated) {
    return Promise.reject(new ProviderError(`${provider.name} is not integrated yet.`, "NOT_INTEGRATED", false));
  }
  const rules = await getRule("deliveryAllocation");
  if (!circuitAllows(provider, rules.circuitCooldownSeconds)) {
    throw new ProviderError(`${provider.name} is paused after repeated failures (circuit open).`, "CIRCUIT_OPEN", false);
  }
  if (!takeToken(provider.code)) throw new ProviderError(`${provider.name}: rate limit reached, try again.`, "UNAVAILABLE", true, 429);

  const ctx = contextFor(provider);
  const timeoutMs = options.timeoutMs ?? provider.timeoutMs;
  const retries = options.retries ?? (options.operation === "cancel" ? 1 : 2);
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const started = Date.now();
    try {
      const result = await withTimeout(run(adapter, { ...ctx, timeoutMs }), timeoutMs, `${provider.name} ${options.operation}`);
      await logCall({ providerCode: provider.code, operation: options.operation, ok: true, durationMs: Date.now() - started, attempt, bookingId: options.bookingId ?? null });
      await recordOutcome(provider, true, null, rules.circuitFailureThreshold);
      return result;
    } catch (error) {
      lastError = error;
      const pe = error instanceof ProviderError ? error : new ProviderError(error instanceof Error ? error.message : "Provider call failed.", "BAD_RESPONSE", false);
      await logCall({
        providerCode: provider.code,
        operation: options.operation,
        ok: false,
        httpStatus: pe.httpStatus ?? null,
        durationMs: Date.now() - started,
        attempt,
        error: `${pe.code}: ${pe.message}`,
        bookingId: options.bookingId ?? null,
      });
      // A refusal (not serviceable, bad request) is an answer, not an outage: it does not trip the breaker.
      if (pe.retryable) await recordOutcome(provider, false, pe.message, rules.circuitFailureThreshold);
      if (!pe.retryable || attempt > retries) throw pe;
      await new Promise((r) => setTimeout(r, Math.min(2000, 150 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 50)));
    }
  }
  throw lastError;
}

export async function listProviders(): Promise<DeliveryProvider[]> {
  return db.select().from(deliveryProviders).orderBy(deliveryProviders.priority, deliveryProviders.code);
}

export async function getProvider(code: string): Promise<DeliveryProvider | null> {
  const [row] = await db.select().from(deliveryProviders).where(eq(deliveryProviders.code, code as DeliveryProviderCode));
  return row ?? null;
}
