/**
 * Bearer-token check for scheduler-triggered endpoints (CRON_SECRET),
 * timing-safe. Same rule as the existing daily-orders cron route, which keeps
 * its own copy untouched.
 */
import { timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";
import { forbidden } from "@/lib/errors";

export function assertCronAuthorized(request: Request): void {
  const header = request.headers.get("authorization") ?? "";
  const provided = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(getEnv().CRON_SECRET);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw forbidden("Invalid cron credentials.");
  }
}
