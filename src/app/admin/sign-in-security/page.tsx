import Link from "next/link";
import { redirect } from "next/navigation";

import { SignInSecurityPanel, type SignInSecurityData } from "@/components/sign-in-security-panel";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { signInSecurityOverview } from "@/server/otp/sign-in-security";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Sign-in security" };
export const dynamic = "force-dynamic";

/**
 * docs/sms-2fa-2026-11 — admin only (others are sent home; the API refuses them
 * too): the SMS sign-in code per audience, the checkout code, and their status.
 */
export default async function SignInSecurityPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  const overview = await signInSecurityOverview();
  const data: SignInSecurityData = {
    ...overview,
    audiences: overview.audiences.map((a) => ({
      ...a,
      lastChange: a.lastChange ? { ...a.lastChange, at: a.lastChange.at.toISOString() } : null,
    })),
  };
  const tab = (await searchParams).tab;
  const trust = await getRule("dualAuth");

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/menu/settings" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Settings
      </Link>
      <PageHeader
        title="Sign-in security"
        description="SMS one-time codes at sign-in (separately for customers and shop owners) and before placing an order. Every change is logged; nothing is asked while SMS codes cannot be sent."
      />
      {/* docs/dual-auth-2026-11: the dual-authentication report lives one click away (no extra menu entry). */}
      <p className="text-sm">
        <Link href="/admin/dual-auth" className="underline" data-testid="dual-auth-report-link">
          Dual authentication report
        </Link>{" "}
        — one-factor accounts, mobile-only shops, account conflicts and the audit trail (IST).
      </p>
      {/* Login & auth item 6 (owner 27-Nov-2026): device trust by role — values from rule dualAuth (Admin → Rules). */}
      <div className="mt-4 rounded-lg border border-cream-200 bg-white p-4 text-sm" data-testid="device-trust-rules">
        <p className="font-semibold text-ink-900">Trusted devices (second code skipped)</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-700">
          <li>
            Customers: <strong>{trust.customerTrustDays} days</strong>, renewed at every sign-in on that device, at most{" "}
            <strong>{trust.customerTrustMaxDays} days</strong> from the first trust.
          </li>
          <li>
            Shop owners, dealers, delivery partners and society admins: <strong>{trust.trustDays} days</strong>, fixed.
          </li>
          <li>Admin, operator and all staff roles: never trusted — both codes at every sign-in.</li>
        </ul>
        <p className="mt-2 text-xs text-ink-500">Change these in rule dualAuth (customerTrustDays, customerTrustMaxDays, trustDays).</p>
      </div>
      <SignInSecurityPanel data={data} initialTab={tab === "checkout" || tab === "status" ? tab : "sms"} />
    </div>
  );
}
