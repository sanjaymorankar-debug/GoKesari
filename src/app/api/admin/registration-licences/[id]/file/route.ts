/** Flow 2 operator queue: open the file of a registration licence (decrypted; every open is audited). */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { readRegistrationLicenceFile } from "@/server/onboarding-v2/shop-flow";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.SHOP_REGISTRATION_MANAGE);
  const { id } = await context.params;
  const file = await readRegistrationLicenceFile(z.string().uuid().parse(id), user);
  return new NextResponse(new Uint8Array(file.data), {
    headers: { "content-type": file.contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": "inline" },
  });
});
