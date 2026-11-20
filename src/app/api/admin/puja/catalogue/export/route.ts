/** The puja master catalogue as CSV (brief §6 bulk export), the layout the import reads back. */
import { NextResponse } from "next/server";

import { route } from "@/server/api/handler";
import { exportMasterCatalogueCsv } from "@/server/puja/admin";
import { requirePujaStaff } from "@/server/puja/route-helpers";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePujaStaff();
  const csv = await exportMasterCatalogueCsv();
  const ist = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="puja-master-catalogue-${ist}.csv"`,
      "cache-control": "no-store",
    },
  });
});
