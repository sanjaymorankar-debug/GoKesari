/**
 * Which payment gateway is in use (batch-2026-10 WS-A).
 *
 *   PAYMENT_GATEWAY = SANDBOX (default) | CASHFREE | RAZORPAY | PHONEPE | HDFC
 *
 * plus that provider's keys (src/lib/env.ts). Nothing else in the code names
 * a vendor. A gateway whose keys are missing is never used: starting a
 * payment fails with GatewayNotConfiguredError rather than half-working.
 * The sandbox is refused in production unless PAYMENT_GATEWAY=SANDBOX and
 * rule onlinePayments.allowSandboxInProduction is on.
 */
import { getEnv, isProductionSite } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { getRule } from "@/server/services/settings";
import { CashfreeGateway } from "./cashfree";
import { HdfcGateway } from "./hdfc";
import { PhonePeGateway } from "./phonepe";
import { RazorpayGateway } from "./razorpay";
import { SandboxGateway } from "./sandbox";
import { GatewayNotConfiguredError, type GatewayName, type PaymentGateway } from "./types";

const instances: Record<GatewayName, PaymentGateway> = {
  SANDBOX: new SandboxGateway(),
  CASHFREE: new CashfreeGateway(),
  RAZORPAY: new RazorpayGateway(),
  PHONEPE: new PhonePeGateway(),
  HDFC: new HdfcGateway(),
};

/** Test seam: replace one gateway's adapter (e.g. a gateway that disagrees with its own webhook). */
const overrides = new Map<GatewayName, PaymentGateway>();

export function setGatewayOverrideForTests(name: GatewayName, gateway: PaymentGateway | null): void {
  if (getEnv().NODE_ENV === "production") throw new Error("Gateway overrides are for tests only.");
  if (gateway) overrides.set(name, gateway);
  else overrides.delete(name);
}

export const GATEWAY_NAMES: readonly GatewayName[] = ["SANDBOX", "CASHFREE", "RAZORPAY", "PHONEPE", "HDFC"];

export function parseGatewayName(value: string): GatewayName | null {
  const upper = value.toUpperCase();
  return (GATEWAY_NAMES as readonly string[]).includes(upper) ? (upper as GatewayName) : null;
}

/** The adapter for one gateway, configured or not. */
export function getGatewayByName(name: GatewayName): PaymentGateway {
  return overrides.get(name) ?? instances[name];
}

/** The gateway new payments go to (PAYMENT_GATEWAY). */
export function getPaymentGateway(): PaymentGateway {
  return getGatewayByName(getEnv().PAYMENT_GATEWAY);
}

/** Whether the sandbox may run here: anywhere but production, or production when explicitly chosen and allowed. */
export async function sandboxAllowed(): Promise<boolean> {
  const env = getEnv();
  // Everywhere but gokesari.com (test.gokesari.com runs a production build too).
  if (!isProductionSite(env)) return true;
  return env.PAYMENT_GATEWAY === "SANDBOX" && (await getRule("onlinePayments")).allowSandboxInProduction;
}

/** Throws unless the gateway can take a payment now. */
export async function assertGatewayUsable(gateway: PaymentGateway): Promise<void> {
  if (!gateway.isConfigured()) throw new GatewayNotConfiguredError(gateway.name);
  if (gateway.name === "SANDBOX" && !(await sandboxAllowed())) {
    throw new AppError("FORBIDDEN", "The sandbox payment gateway is not allowed on this site.");
  }
}
