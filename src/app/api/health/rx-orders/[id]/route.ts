/**
 * One medicine order (src/server/health/rx-orders.ts). The patient side (account holder / linked adult)
 * and the store it was sent to; anyone else gets 404.
 * GET  → the order as the viewer may see it, with what they may do
 * POST { action, … }:
 *   store:   quote {items[], deliveryPaise} · decline {reason} · pack · ready · dispatch {deliveryPerson, deliveryPhone}
 *            · complete {code, billNumber, items[{id, dispensedQty, batchNumber, expiryDate}]} · cancel {reason} · problem {reason}
 *   patient: approve {substitutes{lineId: bool}, paymentMode ONLINE|CASH_ON_HANDOVER} · pay · cancel {reason?}
 *            · newcode · problem {reason}
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import {
  approveRxOrder,
  cancelRxOrder,
  completeRxOrder,
  declineRxOrder,
  dispatchRxOrder,
  newRxCode,
  packRxOrder,
  payRxOrder,
  quoteRxOrder,
  readyRxOrder,
  reportRxProblem,
  rxOrderDetail,
  rxOrderViewer,
  storeCancelRxOrder,
} from "@/server/health/rx-orders";

export const dynamic = "force-dynamic";

const idOf = async (context: RouteContext<{ id: string }>) => z.string().uuid().parse((await context.params).id);
const ipOf = (request: NextRequest) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok(await rxOrderDetail(await idOf(context), user, ipOf(request)));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = await idOf(context);
  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const text = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : null);
  enforceRateLimit(`health-rx-action:${user.id}`, action === "pay" || action === "approve" ? RATE_LIMITS.PAYMENT : RATE_LIMITS.MUTATION);
  // Only the patient side and the store get past the service checks (anyone else: 404).
  const store = (await rxOrderViewer(id, user)) === "STORE";
  switch (action) {
    case "quote":
      return ok({ order: await quoteRxOrder(id, body, user) });
    case "decline":
      return ok({ order: await declineRxOrder(id, text("reason"), user) });
    case "pack":
      return ok({ order: await packRxOrder(id, user) });
    case "ready":
      return ok({ order: await readyRxOrder(id, user) });
    case "dispatch":
      return ok({ order: await dispatchRxOrder(id, body, user) });
    case "complete":
      return ok({ order: await completeRxOrder(id, body, user) });
    case "approve": {
      const r = await approveRxOrder(id, body, user);
      return ok({ order: r.order, checkoutUrl: r.checkoutUrl, intentId: r.intentId });
    }
    case "pay": {
      const r = await payRxOrder(id, user);
      return ok({ checkoutUrl: r.checkoutUrl, intentId: r.intentId });
    }
    case "cancel":
      return ok({ order: store ? await storeCancelRxOrder(id, text("reason"), user) : await cancelRxOrder(id, text("reason"), user) });
    case "newcode":
      await newRxCode(id, user);
      return ok({ done: true });
    case "problem":
      return ok(await reportRxProblem(id, body, user));
    default:
      throw validationFailed("Unknown action.");
  }
});
