import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Alert, PageHeader } from "@/components/ui";
import { StoreRxOrderView } from "@/components/health/rx-store";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";

export const metadata = { title: "Prescription request" };
export const dynamic = "force-dynamic";

/** One prescription request for the medical store: checks, quote or decline, pack, pickup / delivery, complete with the code and the bill. */
export default async function StorePrescriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent(`/shop/health/prescriptions/${id}`)}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  if (!(await healthEnabled())) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Prescription request" />
        <Alert tone="info" title="Coming soon">
          GoKesari Health opens soon.
        </Alert>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/shop/health/prescriptions" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Prescription requests
      </Link>
      <PageHeader title="Prescription request" description="Times in IST. The patient sees each change at once." />
      <StoreRxOrderView orderId={id} />
    </div>
  );
}
