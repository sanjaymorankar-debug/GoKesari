/**
 * Admin coupons on franchise fees (§5.7). GET → every coupon with its state, uses, dealers, discount and revenue;
 * GET ?format=xlsx → the coupon report workbook; POST → create. Operators may read.
 */
import { type NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { couponInputSchema } from "@/server/franchise/coupon-schema";
import { couponReportXlsx, couponUses, createCoupon, listCoupons } from "@/server/franchise/coupons";
import { requireFranchiseAdmin, requireFranchiseReader } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireFranchiseReader();
  if (new URL(request.url).searchParams.get("format") === "xlsx") {
    return new NextResponse(new Uint8Array(await couponReportXlsx()), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": "attachment; filename=franchise-coupons.xlsx" } });
  }
  return ok({ coupons: await listCoupons(), uses: await couponUses() });
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, couponInputSchema);
  return ok({ coupon: await createCoupon(b, actor) }, 201);
});
