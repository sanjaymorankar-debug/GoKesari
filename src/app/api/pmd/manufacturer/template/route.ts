/** GET ?format=xlsx|csv — the manufacturer upload template (batch-2026-10 WS-D, F9.1.2). No data, so no sign-in needed. */
import type { NextRequest } from "next/server";

import { route } from "@/server/api/handler";
import { templateCsv, templateXlsx } from "@/server/pmd/data-sources/manufacturer";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const format = new URL(request.url).searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const body = format === "csv" ? templateCsv() : await templateXlsx();
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="GoKesari_Manufacturer_Template.${format}"`,
      "Cache-Control": "no-store",
    },
  }) as never;
});
