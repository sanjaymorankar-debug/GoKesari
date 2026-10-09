import { redirect } from "next/navigation";

import { RegistrationActions } from "@/components/registration/admin-actions";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listRegistrations, paymentProblems } from "@/server/registration/admin";

export const metadata = { title: "Shop registrations" };
export const dynamic = "force-dynamic";

const when = (d: Date | null) => (d ? d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "–");

/** Module 3: registrations waiting for payment, and payments that need support. */
export default async function ShopRegistrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_REGISTRATION_MANAGE)) redirect("/");
  const params = await searchParams;
  const status = (["PENDING_PAYMENT", "APPROVED", "CANCELLED", "ALL"] as const).find((s) => s === params.status) ?? "PENDING_PAYMENT";
  const [rows, problems] = await Promise.all([listRegistrations(status), paymentProblems()]);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Shop registrations" description="Self-registrations by status. An unpaid one keeps its place on the referral code until its hold ends; resend the payment link by SMS if the applicant lost it." />
      <div className="flex gap-2 text-sm">
        {(["PENDING_PAYMENT", "APPROVED", "CANCELLED", "ALL"] as const).map((s) => (
          <a key={s} href={`?status=${s}`} className={`rounded-full px-3 py-1 ${s === status ? "bg-kesari-600 text-white" : "bg-cream-100"}`}>{s.replace("_", " ").toLowerCase()}</a>
        ))}
      </div>
      {problems.length ? (
        <Alert tone="danger" title="Payments that need support">
          <ul className="mt-1 space-y-1">
            {problems.map((p) => (
              <li key={p.payment.id}>{p.shopName}: {p.payment.status === "MISMATCH" ? `amount did not match the fee (${p.payment.failureReason})` : p.payment.failureReason} — order {p.payment.gatewayOrderId}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <Card className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-cream-100 text-left text-xs text-ink-500">
            <tr><th className="px-3 py-2">Shop</th><th className="px-3 py-2">Started</th><th className="px-3 py-2">Plan · fee</th><th className="px-3 py-2">Code</th><th className="px-3 py-2">Payment</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">{r.shopName}<span className="block text-xs text-ink-500">{r.mobile}</span></td>
                <td className="px-3 py-2 text-xs">{when(r.createdAt)}{r.status === "PENDING_PAYMENT" ? <span className="block">hold until {when(r.holdExpiresAt)}</span> : null}</td>
                <td className="px-3 py-2">{r.tier} · {formatPaise(r.feePaise)}</td>
                <td className="px-3 py-2">{r.code}</td>
                <td className="px-3 py-2"><Badge tone={r.status === "APPROVED" ? "success" : r.lastPaymentStatus === "FAILED" || r.lastPaymentStatus === "MISMATCH" ? "warning" : "neutral"}>{r.status === "APPROVED" ? "paid" : (r.lastPaymentStatus ?? "not started").toLowerCase()}</Badge> <span className="text-xs text-ink-500">{r.attempts} tries</span></td>
                <td className="px-3 py-2">{r.status === "PENDING_PAYMENT" ? <RegistrationActions id={r.id} /> : null}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={6} className="px-3 py-6 text-center text-ink-500">None.</td></tr> : null}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
