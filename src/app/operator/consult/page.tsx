import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Badge, PageHeader } from "@/components/ui";
import { shopTypeLabel } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { consultEnabled } from "@/server/consult/access";
import { setupShopsFor } from "@/server/consult/setup";

export const metadata = { title: "Consultant setup" };
export const dynamic = "force-dynamic";

/**
 * Operators register consultants on their behalf (docs/consult-booking-2026-11): the shop is onboarded with
 * the owner's e-mail consent as for any shop (Onboard a shop), then its booking profile, team, services,
 * hours and map pin are set up here. Only the shops this operator onboarded.
 */
export default async function OperatorConsultPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!(await consultEnabled())) notFound();
  if (!can(user.role, PERMISSIONS.CONSULT_ONBOARD)) redirect("/");
  if (user.role !== "OPERATOR_LIMITED" && user.role !== "OPERATIONS_USER") redirect("/admin/consult"); // docs/rbac
  const shops = await setupShopsFor(user);
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/operator" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Operator
      </Link>
      <PageHeader
        title="Consultant setup"
        description="Register the practice first (Onboard a shop → type “Consultant / Professional Firm”, owner's e-mail code). Then set up its appointments here."
        action={
          <Link href="/operator/onboard" className="inline-flex min-h-11 items-center rounded-lg bg-kesari-600 px-4 text-sm font-bold text-white">
            Onboard a consultant
          </Link>
        }
      />
      <ul className="flex flex-col gap-2">
        {shops.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3">
            <span>
              <strong>{s.name}</strong> <span className="text-sm text-ink-600">{shopTypeLabel(s.shopType)}</span> <Badge>{s.status}</Badge>
            </span>
            <Link href={`/shop/consult/setup?shopId=${s.id}`} className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 bg-white px-4 text-sm font-bold text-ink-800">
              {s.hasProfile ? "Edit appointments" : "Set up appointments"}
            </Link>
          </li>
        ))}
        {shops.length === 0 ? <li className="text-sm text-ink-600">You have not onboarded any shop yet.</li> : null}
      </ul>
    </div>
  );
}
