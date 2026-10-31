/**
 * docs/app-install-2026-10: the signed-in person's install-prompt record.
 *   GET                                  → { declineCount, lastDeclinedAt, installedPlatforms }
 *   POST { event: declined|installed|uninstalled, platform: android|ios|desktop } → the record after it
 * The prompt (src/components/app-install/install-prompt.tsx) reads it on load
 * and posts "Not now" and installs. Signed-out visitors keep the record in
 * localStorage only.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { INSTALL_EVENTS } from "@/lib/app-install";
import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { getAppInstallRecord, recordAppInstallEvent } from "@/server/services/app-install";

export const dynamic = "force-dynamic";

const eventSchema = z.object({
  event: z.enum(INSTALL_EVENTS),
  platform: z.enum(["android", "ios", "desktop"]),
});

export const GET = route(async () => {
  const user = await requireUser();
  return ok(await getAppInstallRecord(user.id));
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`app-install:${user.id}`, { limit: 60, windowMs: 10 * 60_000 });
  const body = await parseBody(request, eventSchema);
  return ok(await recordAppInstallEvent(user.id, body.event, body.platform));
});
