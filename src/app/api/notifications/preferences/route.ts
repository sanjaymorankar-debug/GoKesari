/**
 * Notification settings for the signed-in user.
 *   GET → every category × channel with its effective value and whether the channel is available
 *   PUT { category, channel, enabled } → change one switch (security notices cannot be switched off)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { CATEGORIES } from "@/server/notifications/templates";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { getPreferenceMatrix, setPreference } from "@/server/services/notifications";
import type { CategoryKey } from "@/server/notifications/templates";

export const dynamic = "force-dynamic";

const schema = z.object({
  category: z.string().refine((c) => c in CATEGORIES, "Unknown category."),
  channel: z.enum(["IN_APP", "EMAIL", "SMS", "PUSH", "WHATSAPP"]),
  enabled: z.boolean(),
});

export const GET = route(async () => {
  const user = await requireUser();
  return ok({ preferences: await getPreferenceMatrix(user.id) });
});

export const PUT = route(async (request: NextRequest) => {
  const user = await requireUser();
  const body = await parseBody(request, schema);
  await setPreference(user, body.category as CategoryKey, body.channel, body.enabled);
  return ok({ preferences: await getPreferenceMatrix(user.id) });
});
