/** Bulk product upload (docs/product-import-2026-10): the GoKesari simple template (GoKesari_Product_Upload_Template.xlsx; ?format=csv for the CSV copy). */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { parseQuery, route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { simpleTemplate } from "@/server/services/product-import";

export const dynamic = "force-dynamic";

const query = z.object({ format: z.enum(["xlsx", "csv"]).default("xlsx") });

export const GET = route(async (request: NextRequest) => {
  await requireAnyPermission([PERMISSIONS.EXCEL_UPLOAD_OWN, PERMISSIONS.EXCEL_UPLOAD_ANY]);
  const { format } = parseQuery(request, query);
  const { fileName, bytes } = await simpleTemplate(format);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
