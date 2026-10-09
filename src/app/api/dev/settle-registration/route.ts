/**
 * Mock payments only (local development, CI — no gateway keys): settles a
 * registration's latest mock order through the same code path as the
 * gateway webhook. 404 when a real gateway is configured or in production.
 * POST { token, outcome?: "SUCCESS" | "FAILED" }
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { isPaymentGatewayLive } from "@/lib/env";
import { notFound } from "@/lib/errors";
import { parseBody, route } from "@/server/api/handler";
import { db } from "@/server/db";
import { registrationPayments } from "@/server/db/schema";
import { processRegistrationPaymentEvent, registrationByToken } from "@/server/registration/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  if (process.env.NODE_ENV === "production" || isPaymentGatewayLive()) throw notFound("Page");
  const { token, outcome } = await parseBody(request, z.object({ token: z.string(), outcome: z.enum(["SUCCESS", "FAILED"]).default("SUCCESS") }));
  const reg = await registrationByToken(token);
  const [payment] = await db
    .select()
    .from(registrationPayments)
    .where(eq(registrationPayments.shopRegistrationId, reg.id))
    .orderBy(desc(registrationPayments.createdAt))
    .limit(1);
  if (!payment || payment.gateway !== "MOCK") throw notFound("Mock payment");
  const rupees = payment.amountPaise / 100;
  const result = await processRegistrationPaymentEvent({
    orderId: payment.gatewayOrderId,
    paymentId: outcome === "SUCCESS" ? `mockpay_${randomUUID()}` : null,
    paymentStatus: outcome,
    orderAmount: rupees,
    paymentAmount: rupees,
    currency: "INR",
    raw: { mock: true, outcome },
  });
  return NextResponse.json(result);
});
