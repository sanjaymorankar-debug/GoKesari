import Link from "next/link";
import { redirect } from "next/navigation";

import { ComingSoon } from "@/components/health/page-shell";
import { LiveRefresh } from "@/components/health/live";
import { Alert, PageHeader } from "@/components/ui";
import { formatDateKey } from "@/lib/consult/time";
import { formatPaiseCompact } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { customerRentals } from "@/server/health/rentals";

export const metadata = { title: "My equipment rentals" };
export const dynamic = "force-dynamic";

/** The customer's equipment rentals, newest first (live). */
export default async function MyRentalsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/health/equipment/rentals");
  if (!(await healthEnabled())) return <ComingSoon title="My equipment rentals" />;
  const rentals = await customerRentals(user);
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/health/equipment" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Medical equipment
      </Link>
      <PageHeader title="My equipment rentals" action={<LiveRefresh names={["rental."]} />} />
      {!rentals.length ? <Alert tone="info">No rentals yet. <Link href="/health/equipment" className="font-bold underline">Find equipment</Link>.</Alert> : null}
      <ul className="flex flex-col gap-2" data-testid="rental-list">
        {rentals.map((r) => (
          <li key={r.id}>
            <Link href={`/health/equipment/rentals/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 hover:border-kesari-400">
              <span>
                <span className="block font-extrabold text-ink-900">
                  {r.itemName} × {r.quantity}
                </span>
                <span className="block text-sm text-ink-700">
                  {r.rentalNumber} · {r.shopName} · {formatDateKey(r.startDate)} to {formatDateKey(r.dueDate)} · {formatPaiseCompact(r.totalPaise)}
                  {r.patientName ? ` · for ${r.patientName}` : ""}
                </span>
              </span>
              <span className="rounded-full border px-2 py-0.5 text-xs font-bold">{r.statusLabel}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
