/**
 * GoKesari Health: the only timed work (owner brief: a scheduler only for time-based reminders and
 * expiries). Each is a scheduled_notices row (kind HEALTH_*) that the every-minute notification job
 * claims and runs here; everything else happens at the event.
 *
 *  - HEALTH_RX_EXPIRY      a medical store did not reply to a forwarded prescription in time
 *  - HEALTH_RENTAL_DUE     an equipment rental is due back soon
 *  - HEALTH_PRIME_RENEWAL  a Prime plan ends soon (reminder)
 *  - HEALTH_PRIME_EXPIRY   a Prime plan ended: grace, then back to Free
 */
import type { ScheduledNotice } from "@/server/db/schema";

export const HEALTH_NOTICE_KINDS = ["HEALTH_RX_EXPIRY", "HEALTH_RENTAL_DUE", "HEALTH_PRIME_RENEWAL", "HEALTH_PRIME_EXPIRY"] as const;
export type HealthNoticeKind = (typeof HEALTH_NOTICE_KINDS)[number];

/** True: done (sent / applied). False: nothing to do any more (skipped). */
export async function runHealthNotice(notice: ScheduledNotice): Promise<boolean> {
  switch (notice.kind as HealthNoticeKind) {
    case "HEALTH_RX_EXPIRY":
      return (await import("./rx-orders")).expireRxOrderNotice(notice);
    case "HEALTH_RENTAL_DUE":
      return (await import("./rentals")).sendRentalDueNotice(notice);
    case "HEALTH_PRIME_RENEWAL":
      return (await import("./prime")).sendPrimeRenewalNotice(notice);
    case "HEALTH_PRIME_EXPIRY":
      return (await import("./prime")).applyPrimeExpiryNotice(notice);
    default:
      return false;
  }
}
