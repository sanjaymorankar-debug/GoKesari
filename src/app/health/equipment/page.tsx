import Link from "next/link";

import { EquipmentBrowse } from "@/components/health/equipment";
import { ComingSoon } from "@/components/health/page-shell";
import { PageHeader } from "@/components/ui";
import { healthEnabled } from "@/server/health/access";

export const metadata = { title: "Medical equipment" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * GoKesari Health → Medical equipment (owner brief §2.7): rent or buy from nearby verified stores —
 * wheelchairs, hospital beds, oxygen, monitors. Also the target of "Book now" on a doctor's equipment
 * suggestion (?q=&suggestion=) and of the My Health tile (?patient=).
 */
export default async function EquipmentPage({ searchParams }: { searchParams: Promise<{ q?: string; patient?: string; suggestion?: string }> }) {
  if (!(await healthEnabled())) return <ComingSoon title="Medical equipment" />;
  const sp = await searchParams;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Medical equipment"
        description="Rent or buy from verified stores near you. Rent, refundable deposit and delivery are shown before you pay."
        action={
          <Link href="/health/equipment/rentals" className="inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] bg-white px-4 text-sm font-bold" data-testid="equipment-my-rentals">
            My rentals
          </Link>
        }
      />
      <EquipmentBrowse initial={{ q: sp.q?.slice(0, 80), patientId: sp.patient && UUID.test(sp.patient) ? sp.patient : undefined, suggestionId: sp.suggestion && UUID.test(sp.suggestion) ? sp.suggestion : undefined }} />
    </div>
  );
}
