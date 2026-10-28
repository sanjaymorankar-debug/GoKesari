import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Badge, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listGovDecisions } from "@/server/services/gov-auto-approval";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Instant approvals" };
export const dynamic = "force-dynamic";

type Evidence = {
  gstin?: { status?: string; sourceStatus?: string | null; provider?: string | null; providerRef?: string | null; nameMatchScore?: number | null; number?: string | null } | null;
  pan?: { status?: string; sourceStatus?: string | null; provider?: string | null; providerRef?: string | null; nameMatchScore?: number | null; number?: string | null } | null;
  payment?: { feePaise?: number; gatewayPaise?: number; payments?: { method: string; reference: string }[] };
  duplicate?: { kind?: string; reasons?: string[] };
};

function check(label: string, v: Evidence["gstin"]) {
  if (!v) return null;
  return (
    <span className="block">
      {label} {v.number ?? ""}: {v.status?.toLowerCase()}
      {v.sourceStatus ? `, source ${v.sourceStatus}` : ""}
      {v.nameMatchScore != null ? `, name match ${v.nameMatchScore}` : ""}
      {v.provider ? ` · ${v.provider}${v.providerRef ? ` ref ${v.providerRef}` : ""}` : ""}
    </span>
  );
}

/**
 * Instant approvals on GST/PAN verification + payment (docs/dealer-programme,
 * GKS-SH-004): every shop's latest decision with its evidence — approved, or
 * waiting for an admin and why. Staff with shop-approval rights. A shop
 * approved here can be suspended from Suspensions like any other.
 */
export default async function InstantApprovalsPage({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  if (!(await isFeatureEnabled("gov_verification_auto_approval_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_REGISTRATION_MANAGE)) redirect("/");
  const outcome = (await searchParams).outcome === "PENDING" ? "PENDING" : (await searchParams).outcome === "APPROVED" ? "APPROVED" : undefined;
  const rows = await listGovDecisions({ outcome });

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Link href="/admin/menu/shops" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Shops
      </Link>
      <PageHeader
        title="Instant approvals"
        description="Shops approved with no admin step because their GST/PAN was verified with the government source and the fee came through the payment gateway — and shops still waiting, with the reason. To stop an approved shop, suspend it from Suspensions."
      />
      <nav className="mb-3 flex flex-wrap gap-2 text-sm" aria-label="Filter">
        {[
          ["All", ""],
          ["Approved", "APPROVED"],
          ["Waiting", "PENDING"],
        ].map(([label, value]) => (
          <Link
            key={label}
            href={value ? `/admin/shops/instant-approvals?outcome=${value}` : "/admin/shops/instant-approvals"}
            className={`inline-flex min-h-11 items-center rounded-full border px-3 ${(outcome ?? "") === value ? "border-kesari-700 bg-kesari-700 text-white" : "border-cream-200 bg-white text-ink-700"}`}
          >
            {label}
          </Link>
        ))}
        <Link href="/admin/suspensions" className="inline-flex min-h-11 items-center px-3 font-semibold text-kesari-800 underline">
          Suspensions
        </Link>
      </nav>
      {rows.length === 0 ? <p className="text-sm text-ink-600">Nothing yet.</p> : null}
      <ul className="space-y-2" data-testid="instant-approvals">
        {rows.map((r) => {
          const e = r.evidence as Evidence;
          return (
            <li key={r.id} className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{r.shopName}</span>
                <span className="text-ink-600">{r.registrationNumber ?? ""}</span>
                <Badge tone={r.outcome === "APPROVED" ? "success" : "warning"}>{r.outcome === "APPROVED" ? "approved instantly" : "waiting for admin"}</Badge>
                <span className="text-ink-500">now {r.shopStatus.toLowerCase().replace("_", " ")} · {r.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC</span>
              </p>
              {r.reasons.length ? <p className="mt-1 text-amber-800">Why waiting: {r.reasons.join("; ")}</p> : null}
              <p className="mt-1 text-ink-700">
                {check("GSTIN", e.gstin)}
                {check("PAN", e.pan)}
                {e.payment ? (
                  <span className="block">
                    Fee ₹{((e.payment.feePaise ?? 0) / 100).toLocaleString("en-IN")} · via gateway ₹{((e.payment.gatewayPaise ?? 0) / 100).toLocaleString("en-IN")}
                    {e.payment.payments?.length ? ` (${e.payment.payments.map((p) => `${p.method} ${p.reference}`).join(", ")})` : ""}
                  </span>
                ) : null}
                {e.duplicate?.kind && e.duplicate.kind !== "NONE" ? <span className="block">Possible {e.duplicate.kind.toLowerCase()}: {(e.duplicate.reasons ?? []).join(", ")}</span> : null}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
