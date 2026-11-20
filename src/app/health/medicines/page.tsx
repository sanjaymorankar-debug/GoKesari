import Link from "next/link";

import { PageHeader } from "@/components/ui";
import { LiveRefresh } from "@/components/health/live";
import { BackToHealth, patientPage } from "@/components/health/page-shell";
import { PersonSwitcher } from "@/components/health/patient";
import { RxStatusPill } from "@/components/health/rx-patient";
import { formatIst } from "@/lib/consult/time";
import { formatPaiseCompact } from "@/lib/money";
import { myRxOrders, type RxOrderCard } from "@/server/health/rx-orders";

export const metadata = { title: "Medicine orders" };
export const dynamic = "force-dynamic";

/** A plain string here: constants exported from a client module are references on the server. */
const BTN_PRIMARY = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-kesari-700 px-4 py-2 text-sm font-extrabold text-white hover:bg-kesari-800";
const ACTIVE = ["SENT", "QUOTED", "APPROVED", "PAID", "PACKED", "READY_FOR_PICKUP", "OUT_FOR_DELIVERY"];

function Row({ o }: { o: RxOrderCard }) {
  return (
    <li>
      <Link href={`/health/medicines/${o.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 hover:border-kesari-300" data-testid="rx-my-order">
        <span className="min-w-0">
          <span className="block font-extrabold text-ink-900">{o.shopName}</span>
          <span className="block text-sm text-ink-700">
            {o.items} {o.items === 1 ? "medicine" : "medicines"} · {o.fulfilment === "PICKUP" ? "pickup" : "delivery"} · {o.patientName}
          </span>
          <span className="block text-xs text-ink-500">
            {o.orderNumber} · {o.rxNumber} · {formatIst(o.createdAt)}
            {o.totalPaise ? ` · ${formatPaiseCompact(o.totalPaise)}` : ""}
          </span>
        </span>
        <RxStatusPill status={o.status} />
      </Link>
    </li>
  );
}

/** The patient's medicine orders (prescriptions sent to medical stores), live. */
export default async function MedicineOrdersPage({ searchParams }: { searchParams: Promise<{ patient?: string }> }) {
  const sp = await searchParams;
  const page = await patientPage("/health/medicines", "Medicine orders", sp.patient);
  if (page.kind === "render") return page.node;
  const orders = await myRxOrders(page.user, page.current.id);
  const active = orders.filter((o) => ACTIVE.includes(o.status));
  const past = orders.filter((o) => !ACTIVE.includes(o.status));
  return (
    <div className="mx-auto max-w-3xl">
      <BackToHealth patientId={page.current.id} />
      <PageHeader
        title={`Medicine orders — ${page.current.fullName}`}
        description="Send a prescription to a nearby GoKesari medical store for pickup or home delivery. Times in IST."
        action={<LiveRefresh names={["rx.", "order."]} />}
      />
      <PersonSwitcher people={page.lite} current={page.current.id} basePath="/health/medicines" />
      <div className="mb-4">
        <Link href={`/health/medicines/new?patient=${page.current.id}`} className={BTN_PRIMARY} data-testid="rx-new-order">
          Order medicines from a prescription
        </Link>
      </div>
      <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">In progress</h2>
      {active.length ? (
        <ul className="mb-6 flex flex-col gap-2" data-testid="rx-active">
          {active.map((o) => (
            <Row key={o.id} o={o} />
          ))}
        </ul>
      ) : (
        <p className="mb-6 text-sm text-ink-600">Nothing in progress.</p>
      )}
      <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-600">Earlier</h2>
      {past.length ? (
        <ul className="flex flex-col gap-2">
          {past.map((o) => (
            <Row key={o.id} o={o} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-600">No earlier orders.</p>
      )}
    </div>
  );
}
