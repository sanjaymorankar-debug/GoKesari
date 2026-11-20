import clsx from "clsx";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Alert, PageHeader } from "@/components/ui";
import { RxStatusPill } from "@/components/health/rx-patient";
import { StoreInboxLive } from "@/components/health/rx-store";
import { formatIst } from "@/lib/consult/time";
import { formatPaiseCompact } from "@/lib/money";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { pharmacyProfileOf, pharmacyShopsOf, storeRxInbox, type RxOrderCard } from "@/server/health/rx-orders";

export const metadata = { title: "Prescription requests" };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "new", label: "New", statuses: ["SENT"] },
  { key: "quoted", label: "Quoted", statuses: ["QUOTED"] },
  { key: "pack", label: "To pack", statuses: ["APPROVED", "PAID", "PACKED"] },
  { key: "ready", label: "Ready", statuses: ["READY_FOR_PICKUP", "OUT_FOR_DELIVERY"] },
  { key: "done", label: "Done", statuses: ["COMPLETED", "DECLINED", "EXPIRED", "CANCELLED"] },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function Row({ o }: { o: RxOrderCard }) {
  return (
    <li>
      <Link href={`/shop/health/prescriptions/${o.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 hover:border-kesari-300" data-testid="rx-inbox-row">
        <span className="min-w-0">
          <span className="block font-extrabold text-ink-900">
            {o.patientName} · {o.items} {o.items === 1 ? "medicine" : "medicines"}
          </span>
          <span className="block text-sm text-ink-700">
            {o.fulfilment === "PICKUP" ? `Pickup${o.pickupAt ? ` around ${formatIst(o.pickupAt)}` : ""}` : `Delivery${o.distanceKm != null ? ` · ${o.distanceKm} km` : ""}`}
            {o.totalPaise ? ` · ${formatPaiseCompact(o.totalPaise)}${o.paymentMode === "CASH_ON_HANDOVER" ? " (cash)" : o.paymentStatus === "PAID" ? " (paid online)" : ""}` : ""}
          </span>
          <span className="block text-xs text-ink-500">
            {o.orderNumber} · {o.rxNumber} · {formatIst(o.createdAt)}
            {o.status === "SENT" ? ` · reply by ${formatIst(o.expiresAt)}` : ""}
          </span>
        </span>
        <RxStatusPill status={o.status} />
      </Link>
    </li>
  );
}

/**
 * The medical store's prescription inbox (GoKesari Health): new requests arrive live with a sound; tabs New /
 * Quoted / To pack / Ready / Done. Owners of PHARMACY shops; ?shopId= picks the store.
 */
export default async function StorePrescriptionsPage({ searchParams }: { searchParams: Promise<{ shopId?: string; tab?: string }> }) {
  const sp = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent("/shop/health/prescriptions")}`);
  if (!(await healthEnabled())) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Prescription requests" />
        <Alert tone="info" title="Coming soon">
          GoKesari Health opens soon: patients nearby will send their doctors&apos; prescriptions to your medical store for pickup or delivery.
        </Alert>
      </div>
    );
  }
  const stores = await pharmacyShopsOf(user.id);
  if (!stores.length) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Prescription requests" />
        <Alert tone="info">
          Prescription requests are for medical stores (shop type Pharmacy). <Link href="/shop/register" className="font-bold underline">Register your medical store</Link>, then fill in its drug licence and pharmacist.
        </Alert>
      </div>
    );
  }
  const store = await activeShop(stores, sp.shopId);
  const [{ profile }, orders] = await Promise.all([pharmacyProfileOf(store.id, user), storeRxInbox(store.id, user)]);
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key ?? "new") as TabKey;
  const current = TABS.find((t) => t.key === tab)!;
  const shown = orders.filter((o) => (current.statuses as readonly string[]).includes(o.status));
  const qs = (t: string) => `?${new URLSearchParams({ ...(sp.shopId ? { shopId: sp.shopId } : {}), tab: t }).toString()}`;
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Prescription requests" description={`${store.name} · times in IST`} action={<StoreInboxLive shopId={store.id} />} />
      {stores.length > 1 ? (
        <nav aria-label="Store" className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1">
          {stores.map((s) => (
            <Link key={s.id} href={`?shopId=${s.id}`} aria-current={s.id === store.id ? "page" : undefined} className={clsx("min-h-11 shrink-0 rounded-full border-2 px-4 py-2 text-sm font-extrabold", s.id === store.id ? "border-kesari-700 bg-kesari-700 text-white" : "border-[var(--gk-line)] bg-white text-ink-900")}>
              {s.name}
            </Link>
          ))}
        </nav>
      ) : null}
      {!profile || profile.verification !== "VERIFIED" ? (
        <div className="mb-3">
          <Alert tone="warning" title={!profile ? "Fill in your medical store details" : profile.verification === "REJECTED" ? "Your details need a change" : "Waiting for verification"}>
            {!profile
              ? "Patients can send you prescriptions once your drug licence and registered pharmacist are verified by GoKesari."
              : profile.verification === "REJECTED"
                ? `GoKesari could not verify the details: ${profile.verificationNote ?? ""}`
                : "GoKesari is checking your drug licence and pharmacist. You will start getting requests once verified."}{" "}
            <Link href={`/shop/health/pharmacy?shopId=${store.id}`} className="font-bold underline" data-testid="rx-pharmacy-profile-link">
              Pharmacy profile
            </Link>
          </Alert>
        </div>
      ) : !profile.acceptsPrescriptions ? (
        <div className="mb-3">
          <Alert tone="info">
            You have paused prescription requests. <Link href={`/shop/health/pharmacy?shopId=${store.id}`} className="font-bold underline">Turn them on</Link>
          </Alert>
        </div>
      ) : null}
      <nav aria-label="Requests" className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1" data-testid="rx-inbox-tabs">
        {TABS.map((t) => {
          const n = orders.filter((o) => (t.statuses as readonly string[]).includes(o.status)).length;
          return (
            <Link key={t.key} href={qs(t.key)} aria-current={t.key === tab ? "page" : undefined} className={clsx("min-h-11 shrink-0 rounded-full border-2 px-4 py-2 text-sm font-extrabold", t.key === tab ? "border-kesari-700 bg-kesari-700 text-white" : "border-[var(--gk-line)] bg-white text-ink-900")} data-testid={`rx-tab-${t.key}`}>
              {t.label}
              {t.key !== "done" && n ? ` (${n})` : ""}
            </Link>
          );
        })}
      </nav>
      {shown.length ? (
        <ul className="flex flex-col gap-2" data-testid="rx-inbox">
          {shown.map((o) => (
            <Row key={o.id} o={o} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-600">{tab === "new" ? "No new requests. They appear here the moment a patient sends one (keep this page open to hear them)." : "Nothing here."}</p>
      )}
    </div>
  );
}
