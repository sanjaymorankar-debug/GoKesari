import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { ComingSoon } from "@/components/health/page-shell";
import { MedicineOrderView } from "@/components/health/rx-patient";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";

export const metadata = { title: "Medicine order" };
export const dynamic = "force-dynamic";

/** One medicine order for the patient: status (live), quote and substitutes, pay, pickup / delivery code, bill, cancel, report. */
export default async function MedicineOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent(`/health/medicines/${id}`)}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  if (!(await healthEnabled())) return <ComingSoon title="Medicine order" />;
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/health/medicines" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Medicine orders
      </Link>
      <PageHeader title="Medicine order" description="Times in IST." />
      <MedicineOrderView orderId={id} />
    </div>
  );
}
