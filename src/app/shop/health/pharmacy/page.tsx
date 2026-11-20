import clsx from "clsx";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Alert, PageHeader } from "@/components/ui";
import { PharmacyProfileForm } from "@/components/health/rx-store";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { pharmacyProfileOf, pharmacyShopsOf } from "@/server/health/rx-orders";

export const metadata = { title: "Pharmacy profile" };
export const dynamic = "force-dynamic";

/** The medical store's GoKesari Health details: drug licence, registered pharmacist, delivery options (verified by GoKesari). */
export default async function PharmacyProfilePage({ searchParams }: { searchParams: Promise<{ shopId?: string }> }) {
  const sp = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent("/shop/health/pharmacy")}`);
  if (!(await healthEnabled())) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Pharmacy profile" />
        <Alert tone="info" title="Coming soon">
          GoKesari Health opens soon.
        </Alert>
      </div>
    );
  }
  const stores = await pharmacyShopsOf(user.id);
  if (!stores.length) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Pharmacy profile" />
        <Alert tone="info">
          This is for medical stores (shop type Pharmacy). <Link href="/shop/register" className="font-bold underline">Register your medical store</Link> first.
        </Alert>
      </div>
    );
  }
  const store = await activeShop(stores, sp.shopId);
  const { profile } = await pharmacyProfileOf(store.id, user);
  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/shop/health/prescriptions?shopId=${store.id}`} className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Prescription requests
      </Link>
      <PageHeader title="Pharmacy profile" description={`${store.name} · patients see only verified medical stores.`} />
      {stores.length > 1 ? (
        <nav aria-label="Store" className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1">
          {stores.map((s) => (
            <Link key={s.id} href={`?shopId=${s.id}`} aria-current={s.id === store.id ? "page" : undefined} className={clsx("min-h-11 shrink-0 rounded-full border-2 px-4 py-2 text-sm font-extrabold", s.id === store.id ? "border-kesari-700 bg-kesari-700 text-white" : "border-[var(--gk-line)] bg-white text-ink-900")}>
              {s.name}
            </Link>
          ))}
        </nav>
      ) : null}
      <PharmacyProfileForm
        key={store.id}
        shopId={store.id}
        initial={
          profile
            ? {
                drugLicenceNumber: profile.drugLicenceNumber,
                pharmacistName: profile.pharmacistName,
                pharmacistRegistrationNumber: profile.pharmacistRegistrationNumber,
                pharmacyCouncil: profile.pharmacyCouncil,
                acceptsPrescriptions: profile.acceptsPrescriptions,
                ownDelivery: profile.ownDelivery,
                cashOnHandover: profile.cashOnHandover,
                deliveryRadiusKm: profile.deliveryRadiusKm,
                verification: profile.verification,
                verificationNote: profile.verificationNote,
              }
            : null
        }
      />
    </div>
  );
}
