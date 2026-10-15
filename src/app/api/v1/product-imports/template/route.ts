/** Bulk product upload (docs/product-import-2026-10): the GoKesari simple template (GoKesari_Product_Upload_Template.xlsx). */
import { NextResponse } from "next/server";

import { route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { simpleTemplate } from "@/server/services/product-import";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireAnyPermission([PERMISSIONS.EXCEL_UPLOAD_OWN, PERMISSIONS.EXCEL_UPLOAD_ANY]);
  const { fileName, bytes } = await simpleTemplate();
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
