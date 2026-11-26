import Link from "next/link";

/**
 * docs/dual-auth-2026-11: the in-app banner for a signed-in account with one verified factor (e.g. a shop registered
 * with a mobile number alone). Shown on every page until both are verified; nothing is taken offline.
 */
export function DualAuthBanner({ missing }: { missing: ("MOBILE" | "EMAIL")[] }) {
  if (missing.length === 0) return null;
  const what = missing.length === 2 ? "mobile number and e-mail" : missing[0] === "MOBILE" ? "mobile number" : "e-mail";
  return (
    <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900" data-testid="dual-auth-banner">
      Please verify your {what} to keep ordering and using your shop or dealer tools.{" "}
      <Link href="/account/verify" className="font-medium underline">
        Verify now
      </Link>
    </div>
  );
}
