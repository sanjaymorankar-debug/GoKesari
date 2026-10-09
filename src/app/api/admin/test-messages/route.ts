/** GET ?to= → SMS / WhatsApp written by the MOCK provider (test site only), newest first. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listTestMessages } from "@/server/registration/admin";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.SHOP_REGISTRATION_MANAGE);
  const { to } = parseQuery(request, z.object({ to: z.string().trim().max(20).optional() }));
  return ok({ messages: await listTestMessages(to) });
});
