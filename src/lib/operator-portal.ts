import type { UserRole } from "@/server/db/schema";

/**
 * D-142: the limited operator's pages (/operator/…) for someone else. An admin
 * or full operator who opens an /operator link lands on the matching page of
 * the staff console instead of the shopping home with no word why; anyone else
 * still goes home.
 */
export function operatorPortalFallback(role: UserRole, adminPath: string): string {
  return role === "ADMIN" || role === "OPERATOR" ? adminPath : "/";
}
