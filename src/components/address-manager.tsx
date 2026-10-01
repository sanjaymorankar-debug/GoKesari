"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Field, inputClass } from "@/components/ui";
import { MapPicker, type MapPickerResult } from "@/components/map-picker";

export interface AddressRow {
  id: string;
  label: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  addressType: "HOME" | "WORK" | "OTHER";
  line1: string;
  line2: string | null;
  area: string | null;
  city: string;
  state: string | null;
  pincode: string;
  landmark: string | null;
  deliveryInstructions: string | null;
  latitude: string | null;
  longitude: string | null;
  locationVerified: boolean;
  isDefault: boolean;
}

export function AddressManager({ addresses }: { addresses: AddressRow[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {addresses.length === 0 && !adding ? (
        <EmptyState title="No saved addresses yet." description="Add one to speed up checkout." />
      ) : (
        addresses.map((address) =>
          editingId === address.id ? (
            <Card key={address.id} className="p-6">
              <AddressForm
                address={address}
                onSaved={() => {
                  setEditingId(null);
                  router.refresh();
                }}
                onCancel={() => setEditingId(null)}
              />
            </Card>
          ) : (
            <AddressCard
              key={address.id}
              address={address}
              onEdit={() => setEditingId(address.id)}
              onDeleted={() => router.refresh()}
            />
          ),
        )
      )}

      {adding ? (
        <Card className="p-6">
          <AddressForm
            onSaved={() => {
              setAdding(false);
              router.refresh();
            }}
            onCancel={() => setAdding(false)}
          />
        </Card>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          Add a new address
        </Button>
      )}
    </div>
  );
}

function AddressCard({
  address,
  onEdit,
  onDeleted,
}: {
  address: AddressRow;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    await fetch(`/api/addresses/${address.id}`, { method: "DELETE" });
    setBusy(false);
    onDeleted();
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Badge tone="neutral">
              {address.addressType === "HOME" ? "Home" : address.addressType === "WORK" ? "Work" : "Other"}
            </Badge>
            {address.label ? (
              <span className="text-sm font-semibold text-ink-900">{address.label}</span>
            ) : null}
            {address.isDefault ? <Badge tone="success">Default</Badge> : null}
            {address.locationVerified ? <Badge tone="info">Map-verified</Badge> : null}
          </div>
          <p className="text-sm text-ink-700">
            {address.line1}
            {address.line2 ? `, ${address.line2}` : ""}
          </p>
          <p className="text-sm text-ink-500">
            {[address.area, address.city].filter(Boolean).join(", ")} — {address.pincode}
          </p>
          {address.landmark ? (
            <p className="text-xs text-ink-400">Landmark: {address.landmark}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="danger" onClick={remove} disabled={busy}>
            Delete
          </Button>
        </div>
      </div>
    </Card>
  );
}

function AddressForm({
  address,
  onSaved,
  onCancel,
}: {
  address?: AddressRow;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(address?.label ?? "");
  const [recipientName, setRecipientName] = useState(address?.recipientName ?? "");
  const [recipientPhone, setRecipientPhone] = useState(address?.recipientPhone ?? "");
  const [addressType, setAddressType] = useState<"HOME" | "WORK" | "OTHER">(address?.addressType ?? "HOME");
  const [line1, setLine1] = useState(address?.line1 ?? "");
  const [line2, setLine2] = useState(address?.line2 ?? "");
  const [area, setArea] = useState(address?.area ?? "");
  const [city, setCity] = useState(address?.city ?? "");
  const [state, setState] = useState(address?.state ?? "");
  const [pincode, setPincode] = useState(address?.pincode ?? "");
  const [landmark, setLandmark] = useState(address?.landmark ?? "");
  const [deliveryInstructions, setDeliveryInstructions] = useState(
    address?.deliveryInstructions ?? "",
  );
  const [isDefault, setIsDefault] = useState(address?.isDefault ?? false);
  const [coordinates, setCoordinates] = useState<{ latitude: number; longitude: number } | null>(
    address?.latitude && address?.longitude
      ? { latitude: Number(address.latitude), longitude: Number(address.longitude) }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleMapConfirm(result: MapPickerResult) {
    setCoordinates({ latitude: result.latitude, longitude: result.longitude });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const body = {
      label: label || null,
      recipientName: recipientName || null,
      recipientPhone: recipientPhone || null,
      addressType,
      line1,
      line2: line2 || null,
      area: area || null,
      city,
      state: state || null,
      pincode,
      landmark: landmark || null,
      deliveryInstructions: deliveryInstructions || null,
      latitude: coordinates?.latitude ?? null,
      longitude: coordinates?.longitude ?? null,
      isDefault,
    };

    const response = await fetch(
      address ? `/api/addresses/${address.id}` : "/api/addresses",
      {
        method: address ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setError(payload?.error?.message ?? "Could not save this address.");
      return;
    }
    onSaved();
  }

  return (
    <form className="grid gap-4" onSubmit={save}>
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
          Pin your location (optional but recommended)
        </p>
        <MapPicker
          purpose="address_save"
          initialCoordinates={coordinates}
          onConfirm={handleMapConfirm}
        />
        {coordinates ? (
          <p className="mt-1 text-xs text-leaf-700">Location pinned and confirmed.</p>
        ) : null}
      </div>

      <Field label="Address type">
        <div className="flex gap-2" role="radiogroup" aria-label="Address type">
          {(["HOME", "WORK", "OTHER"] as const).map((type) => (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={addressType === type}
              onClick={() => setAddressType(type)}
              className={`rounded-lg border px-4 py-1.5 text-sm ${
                addressType === type
                  ? "border-kesari-600 bg-kesari-50 font-medium text-kesari-700"
                  : "border-cream-200 text-ink-700"
              }`}
            >
              {type === "HOME" ? "Home" : type === "WORK" ? "Work" : "Other"}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Label (optional)" hint="e.g. Mom's flat">
        <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Recipient name (optional)">
          <input className={inputClass} value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
        </Field>
        <Field label="Recipient mobile (optional)">
          <input
            className={inputClass}
            value={recipientPhone}
            onChange={(e) => setRecipientPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
            inputMode="numeric"
            pattern="[6-9]\d{9}"
          />
        </Field>
      </div>
      <Field label="Address line 1">
        <input
          className={inputClass}
          value={line1}
          onChange={(e) => setLine1(e.target.value)}
          required
        />
      </Field>
      <Field label="Flat / house / floor (optional)">
        <input className={inputClass} value={line2} onChange={(e) => setLine2(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Area">
          <input className={inputClass} value={area} onChange={(e) => setArea(e.target.value)} />
        </Field>
        <Field label="City">
          <input
            className={inputClass}
            value={city}
            onChange={(e) => setCity(e.target.value)}
            required
          />
        </Field>
        <Field label="State">
          <input className={inputClass} value={state} onChange={(e) => setState(e.target.value)} />
        </Field>
        <Field label="PIN code">
          <input
            className={inputClass}
            value={pincode}
            onChange={(e) => setPincode(e.target.value)}
            required
            pattern="\d{6}"
            inputMode="numeric"
          />
        </Field>
      </div>
      <Field label="Landmark (optional)">
        <input
          className={inputClass}
          value={landmark}
          onChange={(e) => setLandmark(e.target.value)}
        />
      </Field>
      <Field label="Delivery instructions (optional)">
        <textarea
          className={inputClass}
          rows={2}
          value={deliveryInstructions}
          onChange={(e) => setDeliveryInstructions(e.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
          className="h-4 w-4 accent-kesari-600"
        />
        Set as default address
      </label>

      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save address"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
