import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RentalScreen } from "@/components/health/equipment";
import { ComingSoon } from "@/components/health/page-shell";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { rentalView } from "@/server/health/rentals";

export const metadata = { title: "Rental" };
export const dynamic = "force-dynamic";

/** One rental for the store: dispatch, delivery with the customer's code, return pickup, condition check, damages and deposit refund. */
export default async function ShopRentalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=/shop/health/equipment/rentals/${id}`);
  if (!(await healthEnabled())) return <ComingSoon title="Rental" />;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const view = await rentalView(id, user).catch(() => null);
  if (!view) notFound();
  if (view.viewer === "CUSTOMER") redirect(`/health/equipment/rentals/${id}`);
  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/shop/health/equipment?shopId=${view.store.shopId}`} className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Equipment rentals
      </Link>
      <RentalScreen rentalId={id} />
    </div>
  );
}
