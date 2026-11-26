import Link from "next/link";
import { redirect } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { dualAuthReport, formatIst } from "@/server/dual-auth/report";

export const metadata = { title: "Dual authentication" };
export const dynamic = "force-dynamic";

const ADMIN_ROLES = new Set(["ADMIN", "OPERATOR", "OPERATIONS_MANAGER", "SUPPORT_MANAGER"]);

function Json({ value }: { value: unknown }) {
  return <code className="break-all text-xs text-ink-600">{value ? JSON.stringify(value) : ""}</code>;
}

/**
 * docs/dual-auth-2026-11 (flag dual_auth): the admin report — flag status, accounts marked needs_second_factor,
 * shops registered with a mobile number only (they stay live and are reminded), accounts in conflict (mobile and
 * e-mail belong to different accounts) for operator review, and the IST audit trail.
 */
export default async function DualAuthAdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!ADMIN_ROLES.has(user.role)) redirect("/");
  const r = await dualAuthReport();
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Dual authentication"
        description="Every account needs a verified mobile (SMS code) and a verified e-mail (code, link or Google). All times IST."
      />
      <Card className="p-4" data-testid="dual-auth-status">
        <p className="text-sm">
          Flag <strong>dual_auth</strong>: {r.flagOn ? "ON" : "OFF"} · SMS codes: {r.smsAvailable ? "available" : "not available"} ·{" "}
          <strong>{r.inForce ? "In force" : r.flagOn ? "On, but not in force (no SMS)" : "Not in force"}</strong> ·{" "}
          <Link href="/admin/feature-flags" className="underline">
            Feature flags
          </Link>{" "}
          ·{" "}
          <Link href="/admin/sign-in-security" className="underline">
            Sign-in security
          </Link>
        </p>
        <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-3" data-testid="dual-auth-counts">
          <li>Accounts needing a second factor: <strong>{r.counts.total}</strong> of {r.counts.live}</li>
          <li>Customers: {r.counts.customers}</li>
          <li>Shop owners: {r.counts.shopOwners}</li>
          <li>No verified mobile: {r.counts.noVerifiedMobile}</li>
          <li>Mobile-only (no e-mail): {r.counts.placeholderEmail}</li>
        </ul>
      </Card>

      <Card className="p-4">
        <h2 className="font-semibold">Shops registered with a mobile number only ({r.mobileOnlyShops.length})</h2>
        <p className="text-xs text-ink-600">They stay live. The owner is asked for an e-mail at the next sign-in, sees a banner, and gets an SMS reminder every few days.</p>
        <table className="mt-2 w-full text-sm" data-testid="dual-auth-mobile-only-shops">
          <thead>
            <tr className="text-left text-xs text-ink-600">
              <th>Shop</th>
              <th>Status</th>
              <th>Owner mobile</th>
              <th>Flagged since</th>
              <th>Last reminder</th>
            </tr>
          </thead>
          <tbody>
            {r.mobileOnlyShops.map((s) => (
              <tr key={s.shopId} className="border-t border-cream-200">
                <td>
                  <Link href={`/admin/shops/${s.shopId}`} className="underline">
                    {s.shopName}
                  </Link>
                </td>
                <td>{s.status}</td>
                <td>{s.phone}</td>
                <td>{formatIst(s.since)}</td>
                <td>{formatIst(s.remindedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="p-4">
        <h2 className="font-semibold">Other shops whose owner has one factor ({r.oneFactorShops.length})</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-600">
              <th>Shop</th>
              <th>Status</th>
              <th>Owner</th>
              <th>Missing</th>
            </tr>
          </thead>
          <tbody>
            {r.oneFactorShops.map((s) => (
              <tr key={s.shopId} className="border-t border-cream-200">
                <td>{s.shopName}</td>
                <td>{s.status}</td>
                <td>
                  {s.email} · {s.phone}
                </td>
                <td>{s.missing}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="p-4">
        <h2 className="font-semibold">Mobile and e-mail on different accounts — for operator review ({r.conflicts.length})</h2>
        <ul className="mt-2 space-y-1 text-sm" data-testid="dual-auth-conflicts">
          {r.conflicts.map((c) => (
            <li key={c.id} className="border-t border-cream-200 pt-1">
              {formatIst(c.at)} · account{" "}
              <Link href={`/admin/users/${c.actorId}`} className="underline">
                {c.actorId?.slice(0, 8)}
              </Link>{" "}
              · <Json value={c.value} />
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4">
        <h2 className="font-semibold">Audit trail (latest 200, IST)</h2>
        <table className="mt-2 w-full text-sm" data-testid="dual-auth-audit">
          <thead>
            <tr className="text-left text-xs text-ink-600">
              <th>When (IST)</th>
              <th>Event</th>
              <th>Account</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {[...r.events].map((e) => (
              <tr key={e.id} className="border-t border-cream-200 align-top">
                <td className="whitespace-nowrap">{formatIst(e.at)}</td>
                <td>{e.action}</td>
                <td>{(e.actorId ?? e.entityId ?? "").slice(0, 8)}</td>
                <td>
                  <Json value={e.value} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
