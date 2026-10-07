"use client";

/** F5 — admin editor for per-shop / per-area delivery slot limits. Empty = no limit at that level. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, EmptyState, Field, inputClass } from "@/components/ui";

export interface SlotCapacityRow {
  id: string;
  shopName: string | null;
  pincode: string | null;
  expressPerHour: number | null;
  standardPerHour: number | null;
  scheduledPerDay: number | null;
  /** GS-027: per chosen time slot of a scheduled delivery. */
  scheduledPerSlot?: number | null;
}

const num = (v: string) => (v.trim() === "" ? null : Number(v));
const show = (v: number | null) => (v == null ? "—" : String(v));

export function DeliverySlotCapacityAdmin({
  rows,
  shops,
  enabled,
}: {
  rows: SlotCapacityRow[];
  shops: { id: string; name: string }[];
  enabled: boolean;
}) {
  const router = useRouter();
  const [scope, setScope] = useState<"shop" | "pincode">("shop");
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const [pincode, setPincode] = useState("");
  const [express, setExpress] = useState("");
  const [standard, setStandard] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [perSlot, setPerSlot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(url: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not save.");
      return;
    }
    router.refresh();
  }

  function save() {
    void call("/api/admin/delivery-slots", {
      method: "PUT",
      body: JSON.stringify({
        shopId: scope === "shop" ? shopId : null,
        pincode: scope === "pincode" ? pincode : null,
        expressPerHour: num(express),
        standardPerHour: num(standard),
        scheduledPerDay: num(scheduled),
        scheduledPerSlot: num(perSlot),
      }),
    });
  }

  return (
    <div className="space-y-4">
      {!enabled ? (
        <Alert tone="warning">
          Slot capacity is switched off (Business rules → deliverySlots). Limits below are kept but not applied.
        </Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold text-ink-900">Set a limit</h2>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input type="radio" checked={scope === "shop"} onChange={() => setScope("shop")} /> One shop
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={scope === "pincode"} onChange={() => setScope("pincode")} /> An area (PIN code)
          </label>
        </div>
        {scope === "shop" ? (
          <Field label="Shop">
            <select className={inputClass} value={shopId} onChange={(e) => setShopId(e.target.value)}>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="PIN code">
            <input className={inputClass} inputMode="numeric" maxLength={6} value={pincode} onChange={(e) => setPincode(e.target.value)} />
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Express orders / hour" hint="Empty = no limit">
            <input className={inputClass} type="number" min={0} value={express} onChange={(e) => setExpress(e.target.value)} />
          </Field>
          <Field label="Standard orders / hour" hint="Empty = no limit">
            <input className={inputClass} type="number" min={0} value={standard} onChange={(e) => setStandard(e.target.value)} />
          </Field>
          <Field label="Scheduled orders / day" hint="Empty = no limit">
            <input className={inputClass} type="number" min={0} value={scheduled} onChange={(e) => setScheduled(e.target.value)} />
          </Field>
          <Field label="Scheduled orders / time slot" hint="Empty = only the day limit">
            <input className={inputClass} type="number" min={0} value={perSlot} onChange={(e) => setPerSlot(e.target.value)} />
          </Field>
        </div>
        <Button onClick={save} disabled={busy}>
          Save limit
        </Button>
      </Card>

      {rows.length === 0 ? (
        <EmptyState title="No shop or area limits yet — the platform defaults apply." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-cream-50 text-left text-ink-500">
              <tr>
                <th className="p-2">Shop / area</th>
                <th className="p-2">Express / h</th>
                <th className="p-2">Standard / h</th>
                <th className="p-2">Scheduled / day</th>
                <th className="p-2">Scheduled / slot</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-cream-200" data-testid="slot-capacity-row">
                  <td className="p-2">{r.shopName ?? `PIN ${r.pincode}`}</td>
                  <td className="p-2">{show(r.expressPerHour)}</td>
                  <td className="p-2">{show(r.standardPerHour)}</td>
                  <td className="p-2">{show(r.scheduledPerDay)}</td>
                  <td className="p-2">{show(r.scheduledPerSlot ?? null)}</td>
                  <td className="p-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void call(`/api/admin/delivery-slots/${r.id}`, { method: "DELETE" })}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
