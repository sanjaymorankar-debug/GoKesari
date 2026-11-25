/**
 * docs/customer-whatsapp-2026-11: use a WhatsApp checkout link from the app.
 *
 * POST { token }  the signed-in customer's cart gets the link's lines (once;
 *                 refused for another customer's link, expired or used links).
 *                 Answers { added, skipped }. Flag whatsapp_customer_enabled off: 404.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { featureNotAvailable, isFeatureEnabled } from "@/server/services/feature-flags";
import { claimCartLink } from "@/server/whatsapp/customer/cart-link";
import { CUSTOMER_WHATSAPP_FLAG } from "@/server/whatsapp/customer/config";

const schema = z.object({ token: z.string().min(10).max(300) });

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  if (!(await isFeatureEnabled(CUSTOMER_WHATSAPP_FLAG))) throw featureNotAvailable(CUSTOMER_WHATSAPP_FLAG);
  const body = await parseBody(request, schema);
  return ok(await claimCartLink(body.token, user));
});
