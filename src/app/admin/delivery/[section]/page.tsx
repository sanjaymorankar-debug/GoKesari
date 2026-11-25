import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  ActionButton,
  CreateSettlement,
  PricingForm,
  ProviderForm,
  ReconcileSettlement,
  ZoneForm,
  ZoneSuspend,
} from "@/components/delivery-admin";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { canConfigureDelivery, canSeeDelivery, canSeeDeliveryFinance } from "@/server/delivery/access";
import {
  BOOKING_GROUPS,
  deliveryDashboard,
  integrationHealth,
  listBookings,
  listPricingRules,
  listProviderViews,
  listShopRiders,
  listWebhookLogs,
} from "@/server/delivery/admin";
import { BOOKING_STATUS_LABELS } from "@/server/delivery/bookings";
import { listSettlements, settlementLines } from "@/server/delivery/settlements";
import { listZones } from "@/server/delivery/zones";
import { getRule } from "@/server/services/settings";

import { DELIVERY_SECTIONS, DeliveryNav, istTime, paise } from "../delivery-nav";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  return { title: DELIVERY_SECTIONS.find((s) => s.key === section)?.label ?? "Delivery management" };
}

/** Admin → Delivery management sections (docs/hdms-2026-11). */
export default async function DeliverySectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const meta = DELIVERY_SECTIONS.find((s) => s.key === section && s.key !== "dashboard");
  if (!meta) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const finance = section === "settlements";
  if (finance ? !canSeeDeliveryFinance(user.role) : !canSeeDelivery(user.role)) redirect("/");
  const canEdit = canConfigureDelivery(user.role);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title={meta.label} />
      <DeliveryNav current={section} />
      {section === "providers" ? <Providers canEdit={canEdit} /> : null}
      {section === "zones" ? <Zones canEdit={canEdit} /> : null}
      {section === "pricing" ? <Pricing canEdit={canEdit} /> : null}
      {section === "allocation" ? <Allocation /> : null}
      {section === "shop-riders" ? <ShopRiders canEdit={canEdit} /> : null}
      {section === "partners" ? <Partners /> : null}
      {section === "active" || section === "completed" || section === "failed" || section === "cancelled" ? <Bookings group={section} /> : null}
      {section === "settlements" ? <Settlements canEdit={canEdit} /> : null}
      {section === "reports" ? <Reports /> : null}
      {section === "health" ? <Health /> : null}
      {section === "webhooks" ? <Webhooks /> : null}
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-ink-500">
          <tr>
            {head.map((h) => (
              <th key={h} className="py-1 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

async function Providers({ canEdit }: { canEdit: boolean }) {
  const providers = await listProviderViews();
  return (
    <div className="space-y-3">
      <Alert tone="info">
        Shadowfax, Pidge, Porter and Borzo do not publish their delivery APIs openly. Each stays <b>not integrated</b> (cannot be switched on, webhooks refused) until its API document, sandbox and agreement arrive and its adapter is built. The sandbox simulator lets staging test the whole flow; it never runs on gokesari.com.
      </Alert>
      {providers.map((p) => (
        <Card key={p.code} className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{p.name}</h2>
            <Badge tone={p.enabled ? "success" : "neutral"}>{p.enabled ? "enabled" : "off"}</Badge>
            <Badge tone={p.integrated ? "info" : "warning"}>{p.integrated ? "integrated" : "not integrated"}</Badge>
            <Badge tone="neutral">{p.environment.toLowerCase()}</Badge>
            {p.circuitState === "OPEN" ? <Badge tone="danger">paused (circuit open)</Badge> : null}
          </div>
          {p.note ? <p className="text-sm text-ink-600">{p.note}</p> : null}
          <p className="text-xs text-ink-500">
            Webhook URL: <code>/api/webhooks/delivery/{p.code.toLowerCase()}</code> · last success {istTime(p.lastSuccessAt)}
            {p.lastError ? ` · last error ${istTime(p.lastErrorAt)}: ${p.lastError}` : ""}
          </p>
          <ProviderForm p={p} canEdit={canEdit} />
        </Card>
      ))}
    </div>
  );
}

async function Zones({ canEdit }: { canEdit: boolean }) {
  const zones = await listZones();
  return (
    <div className="space-y-3">
      <Card className="p-4">
        <Table head={["Zone", "City", "Centre", "Radius", "Max km", "Status", ""]}>
          {zones.map((z) => (
            <tr key={z.id} className="border-t border-cream-100 align-top">
              <td className="py-2 pr-3">
                {z.name} <span className="text-xs text-ink-500">{z.code}</span>
              </td>
              <td className="pr-3">{z.city}</td>
              <td className="pr-3">
                {Number(z.centerLat).toFixed(4)}, {Number(z.centerLng).toFixed(4)}
                {z.polygon ? " (polygon)" : ""}
              </td>
              <td className="pr-3">{(z.radiusM / 1000).toFixed(1)} km</td>
              <td className="pr-3">{Number(z.maxDeliveryKm)}</td>
              <td className="pr-3">
                {z.status === "ACTIVE" ? <Badge tone="success">active</Badge> : <Badge tone="danger">suspended</Badge>}
                {z.suspendedReason ? <div className="text-xs text-ink-500">{z.suspendedReason}{z.suspendedUntil ? ` · until ${istTime(z.suspendedUntil)}` : ""}</div> : null}
              </td>
              <td>
                <ZoneSuspend zoneId={z.id} suspended={z.status === "SUSPENDED"} />
                {canEdit ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-kesari-600">Edit</summary>
                    <ZoneForm zone={{ id: z.id, code: z.code, name: z.name, city: z.city, centerLat: z.centerLat, centerLng: z.centerLng, radiusM: z.radiusM, maxDeliveryKm: z.maxDeliveryKm, polygon: z.polygon }} />
                  </details>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      {canEdit ? (
        <Card className="p-4">
          <h2 className="mb-2 text-base font-semibold">Add a zone</h2>
          <ZoneForm />
        </Card>
      ) : null}
    </div>
  );
}

async function Pricing({ canEdit }: { canEdit: boolean }) {
  const [rules, zones] = await Promise.all([listPricingRules(), listZones()]);
  const zoneName = new Map(zones.map((z) => [z.id, z.name]));
  return (
    <div className="space-y-3">
      <Alert tone="info">
        Pricing rules decide how the cost of a partner delivery is split between the customer, the shop (charged to its wallet at delivery) and GoKesari. The customer&apos;s checkout fee is still the shop&apos;s own delivery fee: changing it at checkout needs the cart to know the delivery address first (see docs/hdms-2026-11).
      </Alert>
      {rules.map((r) => (
        <Card key={r.id} className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{r.name}</h2>
            <Badge tone={r.active ? "success" : "neutral"}>{r.active ? "active" : "inactive"}</Badge>
            <Badge tone="info">{r.commercialModel.replaceAll("_", " ").toLowerCase()}</Badge>
            <span className="text-xs text-ink-500">{r.zoneId ? zoneName.get(r.zoneId) : "every zone"} · priority {r.priority}</span>
          </div>
          <p className="text-sm text-ink-600">
            {paise(r.minFeePaise)} up to {Number(r.baseKm)} km, then {paise(r.perKmPaise)}/km · {paise(r.perKgPaise)}/kg over {r.freeWeightGrams / 1000} kg · express +{paise(r.expressSurchargePaise)} · peak +{paise(r.peakSurchargePaise)}
            {r.freeAbovePaise != null ? ` · free above ${paise(r.freeAbovePaise)}` : ""}
          </p>
          {canEdit ? (
            <details>
              <summary className="cursor-pointer text-sm text-kesari-600">Edit</summary>
              <PricingForm rule={{ ...r, baseKm: r.baseKm }} zones={zones.map((z) => ({ id: z.id, name: z.name }))} />
            </details>
          ) : null}
        </Card>
      ))}
      {canEdit ? (
        <Card className="p-4">
          <h2 className="mb-2 text-base font-semibold">Add a pricing rule</h2>
          <PricingForm zones={zones.map((z) => ({ id: z.id, name: z.name }))} />
        </Card>
      ) : null}
    </div>
  );
}

async function Allocation() {
  const rule = await getRule("deliveryAllocation");
  return (
    <Card className="space-y-2 p-4 text-sm">
      <p>
        <b>Order of preference:</b> {rule.channelOrder.map((c) => ({ SHOP_RIDER: "Shop's own riders", GOKESARI_RIDER: "GoKesari riders", EXTERNAL: "Delivery partners" })[c]).join(" → ")}
      </p>
      <p>
        <b>Book a delivery partner</b> after {rule.externalAfterRiderAttempts} failed GoKesari rider attempt(s), or when the rider search stops.
      </p>
      <p>
        <b>Choosing a partner:</b> fee {rule.weightFee} · ETA {rule.weightEta} · reliability {rule.weightReliability} (weights); partners below {rule.minReliabilityPercent}% reliability are skipped; quotes wait at most {rule.quoteTimeoutMs} ms.
      </p>
      <p>
        <b>Circuit breaker:</b> {rule.circuitFailureThreshold} failures in a row pause a partner for {rule.circuitCooldownSeconds} s.
      </p>
      <p>
        <b>Promised times:</b> {rule.etaBands.map((b) => `up to ${b.upToKm} km: ${b.minMinutes}–${b.maxMinutes} min`).join("; ")} (+{rule.pickupBufferMinutes} min pickup buffer).
      </p>
      <p>
        Product needs are respected: chilled items only go with a refrigerated partner, heavy baskets within a partner&apos;s weight limit, and items with a maximum delivery time only with an ETA inside it. Scheduled deliveries (milk and newspaper subscriptions, chosen time slots) never go through instant allocation.
      </p>
      <Link href="/admin/settings" className="font-medium text-kesari-600 hover:underline">
        Change these in Business rules → deliveryAllocation →
      </Link>
    </Card>
  );
}

async function ShopRiders({ canEdit }: { canEdit: boolean }) {
  const riders = await listShopRiders();
  return (
    <Card className="p-4">
      <p className="mb-2 text-sm text-ink-500">Each shop adds and manages its own riders under Shop → Delivery staff. Only the last 4 characters of an ID number are stored.</p>
      <Table head={["Shop", "Rider", "Phone", "Status", "Vehicle", "ID proof", ""]}>
        {riders.map((r) => (
          <tr key={r.id} className="border-t border-cream-100">
            <td className="py-2 pr-3">{r.shopName}</td>
            <td className="pr-3">{r.name}</td>
            <td className="pr-3">{r.phone.replace(/^(\+91\d{2})\d{6}(\d{2})$/, "$1XXXXXX$2")}</td>
            <td className="pr-3">{!r.isActive ? "deactivated" : r.isAvailable ? "on duty" : "off duty"}</td>
            <td className="pr-3">{r.vehicleType ?? "—"}</td>
            <td className="pr-3">
              {r.idDocumentType ? `${r.idDocumentType.replace("_", " ").toLowerCase()} ••••${r.idDocumentLast4 ?? ""}` : "—"} <Badge tone={r.kycStatus === "VERIFIED" ? "success" : r.kycStatus === "REJECTED" ? "danger" : "neutral"}>{r.kycStatus.toLowerCase().replace("_", " ")}</Badge>
            </td>
            <td className="space-x-1">
              {canEdit && r.kycStatus === "SUBMITTED" ? (
                <>
                  <ActionButton url={`/api/admin/delivery/shop-riders/${r.id}`} body={{ verified: true }} label="Verify" />
                  <ActionButton url={`/api/admin/delivery/shop-riders/${r.id}`} body={{ verified: false }} label="Reject" variant="ghost" />
                </>
              ) : null}
            </td>
          </tr>
        ))}
      </Table>
      {riders.length === 0 ? <p className="text-sm text-ink-500">No shop riders yet.</p> : null}
    </Card>
  );
}

function Partners() {
  return (
    <Card className="space-y-2 p-4 text-sm">
      <p>GoKesari&apos;s own gig riders are managed in the existing screens — registration, identity and licence checks, vehicle, bank account, approval, availability, zone, orders, earnings, payouts, ratings and complaints:</p>
      <ul className="list-disc pl-5">
        <li><Link className="text-kesari-600 hover:underline" href="/admin/console/riders">Riders and applications</Link></li>
        <li><Link className="text-kesari-600 hover:underline" href="/admin/rider-kyc">Rider documents</Link> · <Link className="text-kesari-600 hover:underline" href="/admin/rider-verification">Rider verification</Link> · <Link className="text-kesari-600 hover:underline" href="/admin/rider-changes">Profile changes</Link></li>
        <li><Link className="text-kesari-600 hover:underline" href="/admin/rider-earnings">Rider pay rules</Link> · <Link className="text-kesari-600 hover:underline" href="/admin/rider-payouts">Rider payouts</Link></li>
        <li><Link className="text-kesari-600 hover:underline" href="/admin/ratings">Ratings</Link> · <Link className="text-kesari-600 hover:underline" href="/admin/console/grievances">Complaints</Link> · <Link className="text-kesari-600 hover:underline" href="/admin/disputes">Incidents and disputes</Link></li>
      </ul>
    </Card>
  );
}

async function Bookings({ group }: { group: keyof typeof BOOKING_GROUPS }) {
  const rows = await listBookings({ group, limit: 200 });
  return (
    <Card className="p-4">
      {rows.length === 0 ? (
        <p className="text-sm text-ink-500">No {group} partner deliveries.</p>
      ) : (
        <Table head={["Booked", "Order", "Shop", "Partner", "Status", "Rider", "ETA", "Cost", ""]}>
          {rows.map(({ booking: b, orderNumber, shopName, orderStatus }) => (
            <tr key={b.id} className="border-t border-cream-100">
              <td className="py-2 pr-3">{istTime(b.createdAt)}</td>
              <td className="pr-3">
                {orderNumber} <span className="text-xs text-ink-500">{orderStatus}</span>
              </td>
              <td className="pr-3">{shopName ?? "—"}</td>
              <td className="pr-3">{b.providerCode}</td>
              <td className="pr-3">
                {BOOKING_STATUS_LABELS[b.status]}
                {b.cancelledBy ? <span className="text-xs text-ink-500"> by {b.cancelledBy.toLowerCase()}</span> : null}
                {b.failureReason ? <div className="text-xs text-ink-500">{b.failureReason}</div> : null}
              </td>
              <td className="pr-3">{b.riderName ? `${b.riderName} ${b.riderPhoneMasked ?? ""}` : "—"}</td>
              <td className="pr-3">{istTime(b.etaAt)}</td>
              <td className="pr-3">{paise(b.finalFeePaise ?? b.quotedFeePaise)}</td>
              <td>
                <Link className="text-kesari-600 hover:underline" href={`/admin/delivery/booking/${b.id}`}>
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

async function Settlements({ canEdit }: { canEdit: boolean }) {
  const [settlements, providers] = await Promise.all([listSettlements(), listProviderViews()]);
  const lines = await Promise.all(settlements.slice(0, 10).map(async (s) => [s.id, await settlementLines(s.id)] as const));
  const linesById = new Map(lines);
  return (
    <div className="space-y-3">
      {canEdit ? (
        <Card className="p-4">
          <h2 className="mb-2 text-base font-semibold">New settlement</h2>
          <p className="mb-2 text-sm text-ink-500">Totals every delivered, returned or charged-cancelled booking of the partner in the period (IST dates).</p>
          <CreateSettlement providers={providers.map((p) => ({ code: p.code, name: p.name }))} />
        </Card>
      ) : null}
      {settlements.map((s) => {
        const ls = linesById.get(s.id) ?? [];
        return (
          <Card key={s.id} className="space-y-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">
                {s.providerCode} · {s.periodStart} to {s.periodEnd}
              </h2>
              <Badge tone={s.status === "PAID" ? "success" : s.status === "DISPUTED" ? "danger" : s.status === "RECONCILED" ? "info" : "neutral"}>{s.status.toLowerCase()}</Badge>
            </div>
            <p className="text-sm">
              {s.bookingCount} bookings · expected {paise(s.expectedPaise)} · invoiced {paise(s.invoicedPaise)} · difference {paise(s.differencePaise)}
              {s.invoiceRef ? ` · invoice ${s.invoiceRef}` : ""}
              {s.paidRef ? ` · paid ${s.paidRef}` : ""}
            </p>
            {ls.filter((l) => l.result !== "MATCHED").length ? (
              <ul className="text-xs text-ink-600">
                {ls
                  .filter((l) => l.result !== "MATCHED")
                  .slice(0, 50)
                  .map((l) => (
                    <li key={l.id}>
                      {l.externalRef}: {l.result.replaceAll("_", " ").toLowerCase()} (ours {paise(l.expectedPaise)}, invoice {paise(l.invoicedPaise)})
                    </li>
                  ))}
              </ul>
            ) : null}
            {canEdit ? <ReconcileSettlement settlementId={s.id} status={s.status} /> : null}
          </Card>
        );
      })}
    </div>
  );
}

async function Reports() {
  const stats = await deliveryDashboard(30);
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-base font-semibold">Last 30 days</h2>
      <Table head={["Partner", "Bookings", "Delivered", "Failed", "Success", "Avg minutes", "Cost", "Cost / delivery"]}>
        {stats.byProvider.map((r) => (
          <tr key={r.provider ?? "-"} className="border-t border-cream-100">
            <td className="py-1 pr-3">{r.provider ?? "—"}</td>
            <td className="pr-3">{r.n}</td>
            <td className="pr-3">{r.delivered}</td>
            <td className="pr-3">{r.failed}</td>
            <td className="pr-3">{r.n ? `${Math.round((r.delivered / r.n) * 100)}%` : "—"}</td>
            <td className="pr-3">{r.avgMinutes ? Math.round(r.avgMinutes) : "—"}</td>
            <td className="pr-3">{paise(r.cost)}</td>
            <td>{r.delivered ? paise(Math.round(r.cost / r.delivered)) : "—"}</td>
          </tr>
        ))}
      </Table>
      <h3 className="text-sm font-semibold">Allocation outcomes</h3>
      <ul className="text-sm">
        {stats.runs.map((r) => (
          <li key={`${r.outcome}-${r.channel}`}>
            {r.outcome}
            {r.channel ? ` · ${r.channel}` : ""}: {r.n}
          </li>
        ))}
      </ul>
      <p className="text-xs text-ink-500">GoKesari rider and shop rider deliveries are reported in Admin → Reports and Rider pay as before.</p>
    </Card>
  );
}

async function Health() {
  const [h, providers] = await Promise.all([integrationHealth(24), listProviderViews()]);
  return (
    <div className="space-y-3">
      <Card className="p-4">
        <h2 className="mb-2 text-base font-semibold">Partners now</h2>
        <Table head={["Partner", "Integrated", "Enabled", "Circuit", "Failures in a row", "Last success", "Last error"]}>
          {providers.map((p) => (
            <tr key={p.code} className="border-t border-cream-100">
              <td className="py-1 pr-3">{p.name}</td>
              <td className="pr-3">{p.integrated ? "yes" : "no"}</td>
              <td className="pr-3">{p.enabled ? "yes" : "no"}</td>
              <td className="pr-3">{p.circuitState}</td>
              <td className="pr-3">{p.consecutiveFailures}</td>
              <td className="pr-3">{istTime(p.lastSuccessAt)}</td>
              <td>{p.lastError ?? "—"}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card className="p-4">
        <h2 className="mb-2 text-base font-semibold">API calls, last 24 hours</h2>
        <Table head={["Partner", "Operation", "Calls", "Failures", "p95 ms"]}>
          {h.rows.map((r) => (
            <tr key={`${r.provider}-${r.operation}`} className="border-t border-cream-100">
              <td className="py-1 pr-3">{r.provider}</td>
              <td className="pr-3">{r.operation}</td>
              <td className="pr-3">{r.calls}</td>
              <td className="pr-3">{r.failures}</td>
              <td>{r.p95Ms}</td>
            </tr>
          ))}
        </Table>
        {h.recentErrors.length ? (
          <ul className="mt-2 text-xs text-ink-600">
            {h.recentErrors.map((e) => (
              <li key={e.id}>
                {istTime(e.createdAt)} {e.providerCode} {e.operation} (attempt {e.attempt}): {e.error}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}

async function Webhooks() {
  const logs = await listWebhookLogs(200);
  return (
    <Card className="p-4">
      {logs.length === 0 ? (
        <p className="text-sm text-ink-500">No webhooks received yet.</p>
      ) : (
        <Table head={["Received", "Partner", "Event", "Signature", "Result", "Booking"]}>
          {logs.map((l) => (
            <tr key={l.id} className="border-t border-cream-100">
              <td className="py-1 pr-3">{istTime(l.receivedAt)}</td>
              <td className="pr-3">{l.providerCode}</td>
              <td className="pr-3 font-mono text-xs">{l.eventId}</td>
              <td className="pr-3">{l.signatureValid ? "valid" : <Badge tone="danger">invalid</Badge>}</td>
              <td className="pr-3">{l.result}</td>
              <td>
                {l.bookingId ? (
                  <Link className="text-kesari-600 hover:underline" href={`/admin/delivery/booking/${l.bookingId}`}>
                    Open
                  </Link>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
