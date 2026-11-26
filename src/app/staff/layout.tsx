import { StaffDualAuthGate } from "@/server/dual-auth/page-gate";

/** docs/dual-auth-2026-11 (flag dual_auth): staff verify both factors before any /staff page. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <StaffDualAuthGate fallbackPath="/staff">{children}</StaffDualAuthGate>;
}
