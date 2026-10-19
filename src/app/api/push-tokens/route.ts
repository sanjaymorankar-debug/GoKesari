/**
 * The GoKesari app's push token for the signed-in person (F13.1.2).
 *   POST   { token, platform: android|ios, appVariant?, deviceId?, deviceName? } → registered (idempotent)
 *   DELETE { token } → this device stops receiving pushes for this person
 * The website asks the app for the token through the bridge after sign-in
 * (src/lib/mobile-bridge-push.ts) and posts it here.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { registerPushToken, unregisterPushToken } from "@/server/notifications/push/tokens";

export const dynamic = "force-dynamic";

const registerSchema = z.object({
  token: z.string().min(10).max(200),
  platform: z.enum(["android", "ios"]),
  appVariant: z.enum(["production", "preview"]).optional(),
  deviceId: z.string().max(200).nullish(),
  deviceName: z.string().max(200).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`push-token:${user.id}`, { limit: 30, windowMs: 10 * 60_000 });
  const body = await parseBody(request, registerSchema);
  const row = await registerPushToken(user.id, body);
  return ok({ registered: true, id: row.id, platform: row.platform, active: row.active });
});

export const DELETE = route(async (request: NextRequest) => {
  const user = await requireUser();
  const { token } = await parseBody(request, z.object({ token: z.string().min(10).max(200) }));
  return ok({ unregistered: await unregisterPushToken(user.id, token) });
});
