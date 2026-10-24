/**
 * Registration-fee payments (§3, §4.2, §15).
 *
 * Reads are scoped by capability: an owner sees their own shop's history, an
 * operator/admin sees any. Writes require PAYMENT_RECORD — an owner can never
 * record a payment against their own fee.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { MAX_SHOP_PAYMENT_PAISE } from "@/lib/money-limits";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission, requireShopAccess, requireUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import {
  listAllPayments,
  listPaymentsForShop,
  recordPayment,
} from "@/server/services/shop-payments";

/** A payment time a little ahead of the server clock is tolerated; a later one is a mistake. */
const CLOCK_SKEW_MS = 5 * 60_000;

// TC-FLD-113: an amount up to a named ceiling, a reference for anything but
// cash (unique — checked in the service), and no payment dated in the future.
const schema = z
  .object({
    shopId: z.string().uuid(),
    paymentType: z.enum(["REGISTRATION_FEE", "RENEWAL", "ADJUSTMENT", "REFUND"]),
    amountPaise: z.number().int().positive().max(MAX_SHOP_PAYMENT_PAISE),
    method: z
      .enum(["CASH", "UPI", "BANK_TRANSFER", "CARD", "CHEQUE", "RAZORPAY", "OTHER"])
      .optional(),
    transactionId: z.string().trim().max(120).nullish(),
    paidAt: z.coerce
      .date()
      .refine((d) => d.getTime() <= Date.now() + CLOCK_SKEW_MS, "A payment cannot be dated in the future.")
      .optional(),
    note: z.string().max(500).nullish(),
  })
  .superRefine((v, ctx) => {
    if ((v.method ?? "CASH") !== "CASH" && !v.transactionId) {
      ctx.addIssue({ code: "custom", path: ["transactionId"], message: "Enter the payment's transaction / UTR reference." });
    }
  });

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const shopId = new URL(request.url).searchParams.get("shopId");

  if (shopId) {
    // requireShopAccess covers both cases: the owner passes on ownership, an
    // operator/admin on PAYMENT_VIEW_ANY.
    await requireShopAccess(shopId, {
      anyPermission: PERMISSIONS.PAYMENT_VIEW_ANY,
    });
    return ok({ payments: await listPaymentsForShop(shopId) });
  }

  if (!can(user.role, PERMISSIONS.PAYMENT_VIEW_ANY)) {
    throw forbidden("Specify a shop to view its payment history.");
  }
  return ok({ payments: await listAllPayments() });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PAYMENT_RECORD);
  const body = await parseBody(request, schema);
  return ok(await recordPayment(body, user), 201);
});
