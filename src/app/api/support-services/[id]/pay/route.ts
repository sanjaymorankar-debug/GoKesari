/**
 * POST { method: "WALLET" | "ONLINE" } — pay a support-service request. WALLET (the owner): debited
 * at once (402 with the shortfall when the balance is short). ONLINE: a gateway checkout; the request
 * is paid when the gateway's signed webhook confirms it. docs/dealer-programme, GKS-SP-001.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { payFromWallet, payOnline } from "@/server/services/support-services";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`support-service-pay:${user.id}`, RATE_LIMITS.PAYMENT);
  const id = z.string().uuid().parse((await context.params).id);
  const body = await parseBody(request, z.object({ method: z.enum(["WALLET", "ONLINE"]) }));
  if (body.method === "WALLET") return ok({ request: await payFromWallet(id, user) });
  const created = await payOnline(id, user);
  const checkoutUrl = created.checkout ? (created.checkout.kind === "HOSTED_URL" ? created.checkout.url : (created.checkout.url ?? null)) : null;
  return ok({ intentId: created.intent.id, checkoutUrl });
});
