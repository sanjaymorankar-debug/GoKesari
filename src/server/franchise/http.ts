/** Small helpers shared by the franchise routes (docs/franchise). */
import { forbidden } from "@/lib/errors";
import { requireRole, requireUser } from "@/server/authz/guards";

/** Super-admin (brief §4.4): an admin whose e-mail is listed in FRANCHISE_SUPER_ADMIN_EMAILS (empty = nobody). */
export function isSuperAdmin(email: string | null | undefined): boolean {
  const list = (process.env.FRANCHISE_SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return !!email && list.includes(email.toLowerCase());
}

export async function requireFranchiseAdmin() {
  const user = await requireRole("ADMIN");
  return { id: user.id, role: user.role, superAdmin: isSuperAdmin(user.email) };
}

/** Admin or operator may read the franchise admin screens; only an admin changes anything. */
export async function requireFranchiseReader() {
  const user = await requireUser();
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") throw forbidden("Franchise administration is for GoKesari staff.");
  return user;
}

/** The gateway page to send the payer to (hosted URL), or null (e.g. an SDK token flow). */
export function checkoutUrlOf(created: { checkout?: { kind: string; url?: string | null } | null }): string | null {
  const c = created.checkout;
  if (!c) return null;
  return c.url ?? null;
}

/** "x-forwarded-for" first hop, for the clickwrap record. */
export function clientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
}
