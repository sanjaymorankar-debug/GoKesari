/**
 * docs/shop-welcome-kit-2026-11: download the shop's printable banner again
 * (the welcome e-mail sends all three on go-live). The shop's owner, operations
 * (shop:update:any) and staff with shop-welcome-kit:send (owner, 28-Nov-2026: Operator, Support).
 *
 *   ?lang=en | mr | hi | local   English (default), Marathi, Hindi or the shop's local language
 *   ?format=pdf | png     A4 landscape PDF (default) or the full-size PNG
 */
import { NextResponse, type NextRequest } from "next/server";

import { AppError } from "@/lib/errors";
import { errorResponse } from "@/server/api/handler";
import { getCurrentUser, requireShopAccess } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { shopBannerFiles } from "@/server/shop-banner/welcome-kit";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("NOT_FOUND", "Shop not found.");
    // Staff with shop-welcome-kit:send (Operator, Operations manager, Support) may download any live shop's banner.
    const viewer = await getCurrentUser();
    const staffKit = viewer ? can(viewer.role, PERMISSIONS.SHOP_WELCOME_KIT_SEND) : false;
    await requireShopAccess(id, { anyPermission: staffKit ? PERMISSIONS.SHOP_WELCOME_KIT_SEND : PERMISSIONS.SHOP_UPDATE_ANY });
    const files = await shopBannerFiles(id);
    if (!files) throw new AppError("CONFLICT", "The banner is ready once your shop is approved and live.");
    const asked = request.nextUrl.searchParams.get("lang");
    const lang = asked === "local" ? files.local : asked === "mr" || asked === "hi" ? asked : "en";
    const png = request.nextUrl.searchParams.get("format") === "png";
    const chosen = files.banners.find((b) => b.lang === lang) ?? files.banners[0];
    const body = png ? chosen.banner.png : chosen.banner.pdf;
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": png ? "image/png" : "application/pdf",
        "Content-Length": String(body.length),
        "Content-Disposition": `attachment; filename="${chosen.basename}.${png ? "png" : "pdf"}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
