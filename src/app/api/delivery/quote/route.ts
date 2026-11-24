/**
 * docs/hdms-2026-11: what the delivery pricing rules give for one shop → one of the caller's saved addresses
 * (total, and who pays what). Informational: the checkout fee is unchanged (see README §Pricing).
 */
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { addresses, shops } from "@/server/db/schema";
import { quoteDeliveryFee } from "@/server/delivery/charges";

export const dynamic = "force-dynamic";

const schema = z.object({
  shopId: z.string().uuid(),
  addressId: z.string().uuid(),
  subtotalPaise: z.number().int().min(0).max(100_000_000),
  express: z.boolean().optional(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`delivery-quote:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  const [shop] = await db.select({ latitude: shops.latitude, longitude: shops.longitude }).from(shops).where(and(eq(shops.id, body.shopId), isNull(shops.deletedAt)));
  const [addr] = await db
    .select({ latitude: addresses.latitude, longitude: addresses.longitude })
    .from(addresses)
    .where(and(eq(addresses.id, body.addressId), eq(addresses.userId, user.id), isNull(addresses.deletedAt)));
  if (!shop || !addr) throw notFound("Shop or address");
  const quote = await quoteDeliveryFee({ shop, drop: addr, subtotalPaise: body.subtotalPaise, express: Boolean(body.express) });
  return ok({ quote: quote ? { customerPaise: quote.breakdown.customerPaise, shopPaise: quote.breakdown.shopPaise, gokesariPaise: quote.breakdown.gokesariPaise, totalPaise: quote.breakdown.totalFeePaise, lines: quote.breakdown.lines, model: quote.breakdown.model } : null });
});
