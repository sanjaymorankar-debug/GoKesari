/**
 * Unpaid & expiring shop registrations (0208; docs/shop-registration-subscription-2026-11).
 *
 * GET  ?filter=ALL|UNPAID|EXPIRING_30|EXPIRING_15|EXPIRING_7|GRACE|EXPIRED|ACTIVE|EXEMPT&shopType=&area=&dealerCode=&q=[&format=csv]
 * POST { action: "REMIND", shopIds[] }                                  reminder (in-app + push + e-mail), bulk
 *      { action: "LINK", shopIds[], amountPaise?, validityDays? }        new payment link (cancels the old), bulk
 *      { action: "EXPIRY", shopId, change, reason }                      extend / shorten / set date / expire now
 *      { action: "MARK_PAID", shopId, reference, note, method, amountPaise?, paidOn? }
 *      { action: "SETTINGS", shopId, remindersEnabled?, renewalFeePaise?, graceDays?, reason }
 * Admin and operator only (SHOP_REGISTRATION_SUBSCRIPTION_MANAGE); every action is audited.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  changeRegistrationExpiry,
  createRegistrationLink,
  listShopRegistrations,
  markRegistrationPaid,
  REGISTRATION_FILTERS,
  registrationRowsCsv,
  sendRegistrationReminders,
  updateShopRegistrationSettings,
} from "@/server/services/shop-registration-subscription";

export const dynamic = "force-dynamic";

const query = z.object({
  filter: z.enum(REGISTRATION_FILTERS).optional(),
  shopType: z.string().max(60).optional(),
  area: z.string().max(80).optional(),
  dealerCode: z.string().max(40).optional(),
  q: z.string().max(80).optional(),
  format: z.enum(["json", "csv"]).optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.SHOP_REGISTRATION_SUBSCRIPTION_MANAGE);
  const params = query.parse(Object.fromEntries(new URL(request.url).searchParams));
  const { rows, counts } = await listShopRegistrations(params);
  if (params.format === "csv") {
    return new NextResponse(registrationRowsCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="shop-registrations-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  return ok({ rows, counts });
});

const ids = z.array(z.string().uuid()).min(1).max(500);
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("REMIND"), shopIds: ids }),
  z.object({
    action: z.literal("LINK"),
    shopIds: ids,
    amountPaise: z.number().int().min(100).max(100_000_000).nullish(),
    validityDays: z.number().int().min(1).max(30).nullish(),
    reason: z.string().max(500).nullish(),
  }),
  z.object({
    action: z.literal("EXPIRY"),
    shopId: z.string().uuid(),
    change: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("EXTEND"), days: z.number().int().min(1).max(3650) }),
      z.object({ mode: z.literal("SHORTEN"), days: z.number().int().min(1).max(3650) }),
      z.object({ mode: z.literal("SET_DATE"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
      z.object({ mode: z.literal("EXPIRE_NOW") }),
    ]),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    action: z.literal("MARK_PAID"),
    shopId: z.string().uuid(),
    reference: z.string().min(1).max(120),
    note: z.string().min(1).max(500),
    method: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "OTHER"]),
    amountPaise: z.number().int().min(1).max(100_000_000).nullish(),
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  }),
  z.object({
    action: z.literal("SETTINGS"),
    shopId: z.string().uuid(),
    remindersEnabled: z.boolean().optional(),
    renewalFeePaise: z.number().int().min(0).max(100_000_000).nullable().optional(),
    graceDays: z.number().int().min(0).max(90).nullable().optional(),
    reason: z.string().min(1).max(500),
  }),
]);

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_REGISTRATION_SUBSCRIPTION_MANAGE);
  const input = await parseBody(request, body);
  const actor = { id: user.id, role: user.role };
  switch (input.action) {
    case "REMIND":
      return ok(await sendRegistrationReminders(input.shopIds, actor));
    case "LINK": {
      const created: { shopId: string; linkId: string; url: string | null }[] = [];
      const failed: { shopId: string; reason: string }[] = [];
      for (const shopId of [...new Set(input.shopIds)]) {
        try {
          const r = await createRegistrationLink(shopId, { amountPaise: input.shopIds.length === 1 ? input.amountPaise : null, validityDays: input.validityDays, reason: input.reason }, actor);
          created.push({ shopId, linkId: r.link.id, url: r.url });
        } catch (error) {
          failed.push({ shopId, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return ok({ created, failed });
    }
    case "EXPIRY": {
      const shop = await changeRegistrationExpiry(input.shopId, input.change, input.reason, actor);
      return ok({ shopId: shop.id, expiry: shop.membershipValidUntil });
    }
    case "MARK_PAID": {
      const r = await markRegistrationPaid(input.shopId, input, actor);
      return ok({ reference: r.payment.reference, extendedTo: r.extendedTo, feePaymentStatus: r.feePaymentStatus });
    }
    case "SETTINGS": {
      const shop = await updateShopRegistrationSettings(input.shopId, input, actor);
      return ok({ shopId: shop.id, remindersEnabled: shop.registrationRemindersEnabled, renewalFeePaise: shop.renewalFeePaise, graceDays: shop.registrationGraceDays });
    }
  }
});
