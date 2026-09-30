/**
 * Registry of admin-configurable business rules and their code defaults.
 * Add a new rule group here; services read it with `getRule("<key>")`
 * (services/settings.ts). Nothing below is a hard-coded business decision —
 * each is only the value used until an admin changes it.
 */
import { z } from "zod";

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const RULES = {
  otp: {
    description: "Mobile-login one-time codes: length, expiry, attempt and resend limits.",
    schema: z.object({
      length: int(4, 8),
      expiryMinutes: int(1, 60),
      maxAttempts: int(1, 10),
      resendCooldownSeconds: int(0, 600),
      maxResendsPerWindow: int(1, 20),
      resendWindowMinutes: int(1, 1440),
      /** Requests per phone number + per IP within `resendWindowMinutes`. */
      maxRequestsPerIpPerWindow: int(1, 200),
      smsEnabled: z.boolean(),
    }),
    defaults: {
      length: 6,
      expiryMinutes: 10,
      maxAttempts: 5,
      resendCooldownSeconds: 60,
      maxResendsPerWindow: 5,
      resendWindowMinutes: 60,
      maxRequestsPerIpPerWindow: 20,
      smsEnabled: false,
    },
  },
  dispatch: {
    description:
      "Finding a rider: offer lifetime, retry cadence and limits, and when the search stops.",
    schema: z.object({
      /** How long a rider has to accept an offer. */
      offerTtlSeconds: int(30, 900),
      /** Wait between automatic attempts to match a rider for one order. */
      retryIntervalSeconds: int(15, 1800),
      /** Matching attempts (each offer counts) before automatic retries stop. */
      maxAttempts: int(1, 100),
      /** Total search time before automatic retries stop. */
      maxSearchMinutes: int(1, 720),
      /** Keep searching this long past the promised delivery time, then stop. */
      windowGraceMinutes: int(0, 240),
      /** Minimum gap between two manual "Find rider now" presses for one order. */
      manualCooldownSeconds: int(0, 600),
      /** Tell the shop after this many unsuccessful attempts (then once more when the search stops). */
      notifyShopAfterAttempts: int(1, 20),
    }),
    defaults: {
      offerTtlSeconds: 120,
      retryIntervalSeconds: 60,
      maxAttempts: 10,
      maxSearchMinutes: 30,
      windowGraceMinutes: 15,
      manualCooldownSeconds: 30,
      notifyShopAfterAttempts: 1,
    },
  },
} as const satisfies Record<string, { description: string; schema: z.ZodType; defaults: unknown }>;

export type RuleKey = keyof typeof RULES;
export type RuleValue<K extends RuleKey> = z.infer<(typeof RULES)[K]["schema"]>;
