/**
 * docs/identity-verification-2026-11: the signed-in person's identity check —
 * whether it is needed, its status (masked id only) and the methods offered.
 */
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { getMyIdentityStatus } from "@/server/services/identity-verification";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok(await getMyIdentityStatus(user.id));
});
