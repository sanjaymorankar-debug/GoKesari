/**
 * Prefixed codes (brief §2.2, §3.2): GKD- dealer, GKT- team lead, GKA- agent, GKF- franchise, each followed by
 * 6 characters of the referral-code alphabet (no 0/O, 1/I/L). They are ordinary referral_codes rows, so every
 * existing registration path accepts them; codes issued before 21-Nov-2026 keep working unchanged.
 */
import { randomInt } from "node:crypto";

import { REFERRAL_CODE_ALPHABET } from "@/lib/referral-codes";

export type CodePrefix = "GKD" | "GKT" | "GKA" | "GKF";

export function prefixedCode(prefix: CodePrefix): string {
  let out = `${prefix}-`;
  for (let i = 0; i < 6; i++) out += REFERRAL_CODE_ALPHABET[randomInt(0, REFERRAL_CODE_ALPHABET.length)];
  return out;
}
