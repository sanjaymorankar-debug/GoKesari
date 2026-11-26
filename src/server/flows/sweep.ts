/**
 * docs/flows-v3/wave2.md: the wave-2 steps of the every-minute timeout sweep (cron/schedule.ts timeoutSweep). Each
 * step is a no-op while its flag is off and never stops the others.
 *   flow_f19  no-rider cancels, uncollected-pickup notices
 *   flow_f16  failed-delivery refunds
 */
import { runFailedDeliveryRefunds } from "./f16-cancellations";
import { remindUncollectedPickups, runNoRiderCancellations } from "./f19-timeouts";

async function guarded<T>(name: string, run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    console.error(`[flows-v3] sweep step ${name} failed`, error);
    return { error: error instanceof Error ? error.message : "failed" };
  }
}

export async function runFlowsV3Sweep(now: Date = new Date()) {
  return {
    noRider: await guarded("no-rider", () => runNoRiderCancellations(now)),
    uncollectedPickups: await guarded("uncollected-pickups", () => remindUncollectedPickups(now)),
    failedDeliveries: await guarded("failed-deliveries", () => runFailedDeliveryRefunds(now)),
  };
}
