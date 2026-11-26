"use client";

/**
 * docs/onboarding-v2-2026-11, step 5: right after payment, the delivery location of the orders that were placed
 * before it was known — a saved address, or GPS + map pin with the house / street details. Optional: name, "save
 * this address", referral code. Rider dispatch waits for it (orders.address_pending_since). Pickup orders never
 * come here.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { MapPicker } from "@/components/map-picker";
import { Alert, Button, Card, Field, Money, inputClass } from "@/components/ui";
import { getCurrentPosition } from "@/lib/geo/provider";

export interface PendingOrderView {
  id: string;
  orderNumber: string;
  shopName: string;
  totalPaise: number;
  paymentMethod: string;
}

export interface SavedAddressView {
  id: string;
  label: string | null;
  line1: string;
  area: string | null;
  city: string;
  pincode: string;
}

export function DeliveryLocationPrompt({
  orders,
  addresses,
  referral,
  placed = false,
}: {
  orders: PendingOrderView[];
  addresses: SavedAddressView[];
  /** null: the referral box is not offered (a code was already given). */
  referral: { prefill: string } | null;
  /** Shown right after "Place order". */
  placed?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"saved" | "new">(addresses.length > 0 ? "saved" : "new");
  const [addressId, setAddressId] = useState(addresses[0]?.id ?? "");
  const [pin, setPin] = useState<{ latitude: number; longitude: number } | null>(null);
  const [line1, setLine1] = useState("");
  const [area, setArea] = useState("");
  const [city, setCity] = useState("");
  const [pincode, setPincode] = useState("");
  const [landmark, setLandmark] = useState("");
  const [name, setName] = useState("");
  // DEFAULT – confirm with Sanjay: "Save this address" starts ticked.
  const [saveAddress, setSaveAddress] = useState(true);
  const [referralCode, setReferralCode] = useState(referral?.prefill ?? "");
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referralNote, setReferralNote] = useState<string | null>(null);
  const next = orders.length === 1 ? `/orders/${orders[0].id}` : "/orders?placed=1";

  async function useGps() {
    setLocating(true);
    setError(null);
    try {
      setPin(await getCurrentPosition());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not get your location. Set the pin on the map.");
    } finally {
      setLocating(false);
    }
  }

  const newReady = pin != null && line1.trim() !== "" && city.trim() !== "" && /^[1-9]\d{5}$/.test(pincode.trim());
  const ready = mode === "saved" ? Boolean(addressId) : newReady;

  const [cancelling, setCancelling] = useState(false);
  /** Until the location is set the customer may always cancel for a full refund (cancelOrder, address pending). */
  async function cancelAll() {
    if (!window.confirm("Cancel this order? You get a full refund.")) return;
    setCancelling(true);
    setError(null);
    for (const o of orders) {
      const response = await fetch(`/api/orders/${o.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CANCELLED", note: "Cancelled by the customer before giving a delivery location" }),
      }).catch(() => null);
      if (!response?.ok) {
        const payload = await response?.json().catch(() => null);
        setCancelling(false);
        setError(payload?.error?.message ?? `Could not cancel ${o.orderNumber}. Please try again.`);
        return;
      }
    }
    setCancelling(false);
    router.push("/orders?cancelled=1");
    router.refresh();
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/onboarding-v2/orders/delivery-location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderIds: orders.map((o) => o.id),
        ...(mode === "saved"
          ? { addressId }
          : { address: { line1, area: area || null, city, pincode, landmark: landmark || null, latitude: pin!.latitude, longitude: pin!.longitude }, saveAddress }),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(referral && referralCode.trim() ? { referralCode: referralCode.trim() } : {}),
      }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setError(payload?.error?.message ?? "Could not save the delivery location. Please try again.");
      return;
    }
    if (payload?.referral && !payload.referral.applied) {
      // The location is saved; only the code was refused. Say so; the customer goes on from the note.
      setReferralNote(`Location saved. Referral code not used: ${payload.referral.message ?? "not valid"}`);
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <Card className="space-y-4 border-kesari-300 p-4 sm:p-5" data-testid="delivery-location-prompt">
      <div>
        <h2 className="text-lg font-bold text-ink-900">{placed ? "Order placed — where should we deliver?" : "Where should we deliver?"}</h2>
        <p className="mt-1 text-sm text-ink-600">
          The shop is preparing your order. A delivery partner is assigned as soon as you set the location.
        </p>
        <ul className="mt-2 space-y-1 text-sm">
          {orders.map((o) => (
            <li key={o.id} className="flex justify-between gap-2">
              <span>
                {o.orderNumber} · {o.shopName} {o.paymentMethod === "COD" ? "(cash on delivery)" : ""}
              </span>
              <Money paise={o.totalPaise} className="font-medium" />
            </li>
          ))}
        </ul>
      </div>

      {addresses.length > 0 ? (
        <div className="flex gap-2" role="tablist">
          <Button variant={mode === "saved" ? "primary" : "secondary"} size="sm" onClick={() => setMode("saved")}>
            Saved address
          </Button>
          <Button variant={mode === "new" ? "primary" : "secondary"} size="sm" onClick={() => setMode("new")}>
            New location
          </Button>
        </div>
      ) : null}

      {mode === "saved" ? (
        <fieldset className="space-y-2">
          <legend className="sr-only">Saved addresses</legend>
          {addresses.map((a) => (
            <label key={a.id} className="flex min-h-11 items-start gap-2 rounded-lg border border-cream-200 p-3 text-sm">
              <input type="radio" name="saved-address" checked={addressId === a.id} onChange={() => setAddressId(a.id)} className="mt-0.5" />
              <span>
                {a.label ? <strong>{a.label} — </strong> : null}
                {a.line1}, {[a.area, a.city].filter(Boolean).join(", ")} — {a.pincode}
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={useGps} disabled={locating} data-testid="delivery-location-gps">
              {locating ? "Finding you…" : "Use my current location"}
            </Button>
            {pin ? <span className="text-xs text-leaf-700">Location set ({pin.latitude.toFixed(4)}, {pin.longitude.toFixed(4)}) — move the pin to adjust.</span> : null}
          </div>
          <MapPicker
            purpose="address_save"
            initialCoordinates={pin}
            onConfirm={(r) => {
              setPin({ latitude: r.latitude, longitude: r.longitude });
              if (!line1.trim() && r.formattedAddress) setLine1(r.formattedAddress.slice(0, 200));
            }}
          />
          <Field label="House / flat, building, street">
            <input className={inputClass} value={line1} onChange={(e) => setLine1(e.target.value)} maxLength={200} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Area (optional)">
              <input className={inputClass} value={area} onChange={(e) => setArea(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Landmark (optional)">
              <input className={inputClass} value={landmark} onChange={(e) => setLandmark(e.target.value)} maxLength={120} />
            </Field>
            <Field label="City">
              <input className={inputClass} value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} />
            </Field>
            <Field label="PIN code">
              <input className={inputClass} inputMode="numeric" value={pincode} onChange={(e) => setPincode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
            </Field>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={saveAddress} onChange={(e) => setSaveAddress(e.target.checked)} />
            Save this address for next time
          </label>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Your name (optional)">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />
        </Field>
        {referral ? (
          <Field label="Referral code (optional)">
            <input className={inputClass} value={referralCode} onChange={(e) => setReferralCode(e.target.value.toUpperCase())} maxLength={32} />
          </Field>
        ) : null}
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {referralNote ? (
        <>
          <Alert tone="warning">{referralNote}</Alert>
          <Button size="lg" className="w-full font-bold" onClick={() => { router.push(next); router.refresh(); }}>
            Track my order
          </Button>
        </>
      ) : (
        <Button size="lg" className="w-full font-bold" disabled={!ready || busy} onClick={submit} data-testid="delivery-location-save">
          {busy ? "Saving…" : "Deliver here"}
        </Button>
      )}
      {referralNote ? null : (
        <Button variant="ghost" className="w-full" disabled={busy || cancelling} onClick={cancelAll} data-testid="delivery-location-cancel">
          {cancelling ? "Cancelling…" : "Cancel the order instead (full refund)"}
        </Button>
      )}
    </Card>
  );
}
