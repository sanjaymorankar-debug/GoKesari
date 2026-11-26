/**
 * docs/dual-auth-2026-11: the page-side DualVerify gate for whole areas (admin, operator, staff). A signed-in staff
 * account with one verified factor is sent to /account/verify and comes back to the same page afterwards; anyone
 * else passes through to the area's own checks. Best-effort: an error never locks anyone out.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { REQUEST_PATH_HEADER } from "@/lib/request-path";
import { getCurrentUser } from "@/server/authz/guards";
import { dualVerifyRedirect, isStaffRole } from "./policy";

export async function StaffDualAuthGate({ children, fallbackPath }: { children: React.ReactNode; fallbackPath: string }) {
  const user = await getCurrentUser();
  const path = (await headers()).get(REQUEST_PATH_HEADER) || fallbackPath;
  // The test site's mock SMS outbox (SMS_PROVIDER=mock only) is where a staff account reads its own SMS code.
  const mockOutbox = path.startsWith("/admin/test-messages") && process.env.SMS_PROVIDER === "mock";
  if (user && isStaffRole(user.role) && !mockOutbox) {
    const verifyAt = await dualVerifyRedirect(user.id, path).catch(() => null);
    if (verifyAt) redirect(verifyAt);
  }
  return <>{children}</>;
}
