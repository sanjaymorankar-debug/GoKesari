/**
 * Small helpers shared by the gateway adapters (batch-2026-10 WS-A).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";
import type { GatewayOrderStatus, PaymentMethodKind } from "./types";

/** How old a signed webhook may be before it is refused as a replay. */
export const WEBHOOK_FRESHNESS_MS = 5 * 60_000;

/** Public origin for return / webhook URLs: PAYMENT_PUBLIC_BASE_URL, else AUTH_URL, else localhost. */
export function paymentBaseUrl(): string {
  const env = getEnv();
  const base = env.PAYMENT_PUBLIC_BASE_URL ?? env.AUTH_URL ?? "http://localhost:3000";
  return base.replace(/\/+$/, "");
}

/** The webhook URL to register with a gateway. */
export function webhookUrlFor(gateway: string): string {
  return `${paymentBaseUrl()}/api/webhooks/payments/${gateway.toLowerCase()}`;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function hmacBase64(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("base64");
}

export function sha256Hex(message: string): string {
  return createHash("sha256").update(message).digest("hex");
}

/**
 * A webhook timestamp (seconds or milliseconds since the epoch) within the
 * freshness window. Anything unparsable is stale.
 */
export function isFresh(timestamp: string | null, now: number = Date.now()): boolean {
  if (!timestamp || !/^\d{9,14}$/.test(timestamp)) return false;
  let ms = Number(timestamp);
  if (ms < 1e12) ms *= 1000;
  return Math.abs(now - ms) <= WEBHOOK_FRESHNESS_MS;
}

export function rupees(paise: number): number {
  return Math.round(paise) / 100;
}

export function paise(rupeeAmount: number | string | null | undefined): number | null {
  if (rupeeAmount == null || rupeeAmount === "") return null;
  const n = Number(rupeeAmount);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** A gateway's own method label → ours. */
export function methodKind(raw: string | null | undefined): PaymentMethodKind | null {
  const value = (raw ?? "").toLowerCase();
  if (!value) return null;
  if (value.includes("upi")) return "UPI";
  if (value.includes("card") || value === "cc" || value === "dc") return "CARD";
  if (value.includes("net") || value === "nb") return "NETBANKING";
  return null;
}

export function isTerminal(status: GatewayOrderStatus): boolean {
  return status === "CAPTURED" || status === "FAILED" || status === "EXPIRED";
}

export async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    // The body is logged, never the request (it carries keys in headers).
    console.error(`[payments:${label}] HTTP ${response.status}`, text.slice(0, 500));
    throw new Error(`${label} failed (HTTP ${response.status}).`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned a body that is not JSON.`);
  }
}
