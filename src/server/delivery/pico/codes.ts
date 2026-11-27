/**
 * The 6-digit codes of a Pico shipment (docs/pico-xpress-2026-11): the customer's delivery code (consigneeOtp —
 * the order completes only when Pico's rider enters it) and the shop's pickup code (pickupOtp). Derived with
 * HMAC-SHA256(AUTH_SECRET) from the shipment's random nonce, like the pickup code of fulfilment options, so the
 * codes are never stored: a copy of the database alone cannot reveal them.
 */
import { createHmac, randomBytes } from "node:crypto";

import { getEnv } from "@/lib/env";

export function newCodeNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Pure given the secret: 6 digits from HMAC(secret, purpose:nonce). */
export function deriveCode(secret: string, nonce: string, purpose: "pickup" | "delivery" | "return"): string {
  const mac = createHmac("sha256", secret).update(`pico-code:${purpose}:${nonce}`).digest();
  return String(mac.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function shipmentCodes(nonce: string): { pickupOtp: string; consigneeOtp: string; returnOtp: string } {
  const secret = getEnv().AUTH_SECRET;
  return {
    pickupOtp: deriveCode(secret, nonce, "pickup"),
    consigneeOtp: deriveCode(secret, nonce, "delivery"),
    returnOtp: deriveCode(secret, nonce, "return"),
  };
}
