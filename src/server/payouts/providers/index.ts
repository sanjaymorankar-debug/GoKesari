import type { PayoutProvider, PayoutProviderName } from "../types";
import { cashfreePayoutProvider } from "./cashfree";
import { razorpayxPayoutProvider } from "./razorpayx";
import { sandboxPayoutProvider } from "./sandbox";

const PROVIDERS: Record<PayoutProviderName, PayoutProvider> = {
  SANDBOX: sandboxPayoutProvider,
  RAZORPAYX: razorpayxPayoutProvider,
  CASHFREE: cashfreePayoutProvider,
};

export function getPayoutProvider(name: string): PayoutProvider | null {
  const key = name.toUpperCase() as PayoutProviderName;
  return PROVIDERS[key] ?? null;
}
