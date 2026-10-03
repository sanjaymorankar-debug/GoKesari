/** Release a mobile number from whichever account holds it. ADMIN only (USER_SUSPEND). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { releaseMobileNumber } from "@/server/services/users";

const schema = z.object({ mobile: z.string().trim().min(10).max(20), reason: z.string().trim().min(3).max(500) });

export const POST = route(async (request: NextRequest) => {
  const actor = await requirePermission(PERMISSIONS.USER_SUSPEND);
  const { mobile, reason } = await parseBody(request, schema);
  return ok(await releaseMobileNumber(mobile, reason, actor));
});
