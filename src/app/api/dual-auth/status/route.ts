/**
 * docs/dual-auth-2026-11: the signed-in account's factors for the DualVerify page / dialog.
 * { mobileVerified, emailVerified, placeholderEmail, missing, maskedPhone, maskedEmail, inForce }.
 */
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { dualVerifyStatus } from "@/server/dual-auth/verify";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok(await dualVerifyStatus(user.id));
});
