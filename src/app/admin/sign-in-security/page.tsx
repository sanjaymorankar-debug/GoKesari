import Link from "next/link";
import { redirect } from "next/navigation";

import { SignInSecurityPanel, type SignInSecurityData } from "@/components/sign-in-security-panel";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { signInSecurityOverview } from "@/server/otp/sign-in-security";

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

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/menu/settings" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Settings
      </Link>
      <PageHeader
        title="Sign-in security"
        description="SMS one-time codes at sign-in (separately for customers and shop owners) and before placing an order. Every change is logged; nothing is asked while SMS codes cannot be sent."
      />
      <SignInSecurityPanel data={data} initialTab={tab === "checkout" || tab === "status" ? tab : "sms"} />
    </div>
  );
}
