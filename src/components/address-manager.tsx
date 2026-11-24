"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Field, inputClass } from "@/components/ui";
import { MapPicker, type MapPickerResult } from "@/components/map-picker";
import { ConfirmButton } from "@/components/confirm-button";
import { mobileFieldDigits } from "@/lib/contact";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";

/** Field names in the address API's validation errors → the form's labels (TC-FLD-125). */
const FIELD_LABELS: Record<string, Text> = {
  label: L("Label", "नाम", "नाव"),
  recipientName: L("Recipient name", "पाने वाले का नाम", "घेणाऱ्याचे नाव"),
  recipientPhone: L("Recipient mobile", "पाने वाले का मोबाइल", "घेणाऱ्याचा मोबाइल"),
  line1: L("Address line 1", "पता पंक्ति 1", "पत्ता ओळ 1"),
  line2: L("Flat / house / floor", "फ़्लैट / मकान / मंज़िल", "फ्लॅट / घर / मजला"),
  area: L("Area", "इलाका", "परिसर"),
  city: L("City", "शहर", "शहर"),
  state: L("State", "राज्य", "राज्य"),
  pincode: L("PIN code", "पिन कोड", "पिन कोड"),
  landmark: L("Landmark", "पहचान का स्थान", "खूण"),
  deliveryInstructions: L("Delivery instructions", "डिलीवरी निर्देश", "डिलिव्हरी सूचना"),
};

/** Module 6 (docs/hindi-marathi-2026-11): the address screens' wording. */
const T = {
  emptyTitle: L("No saved addresses yet.", "अभी कोई पता सहेजा नहीं है।", "अजून पत्ता जतन केलेला नाही."),
  emptyText: L("Add one to speed up checkout.", "ऑर्डर जल्दी करने के लिए एक पता जोड़ें।", "ऑर्डर लवकर देण्यासाठी एक पत्ता जोडा."),
  addNew: L("Add a new address", "नया पता जोड़ें", "नवीन पत्ता जोडा"),
  home: L("Home", "घर", "घर"),
  work: L("Work", "ऑफ़िस", "ऑफिस"),
  other: L("Other", "अन्य", "इतर"),
  default: L("Default", "मुख्य", "मुख्य"),
  mapVerified: L("Map-verified", "नक्शे से सत्यापित", "नकाशावर पडताळलेले"),
  landmark: L("Landmark:", "पहचान का स्थान:", "खूण:"),
  edit: L("Edit", "बदलें", "बदला"),
  yesDelete: L("Yes, delete", "हाँ, हटाएँ", "हो, काढा"),
  deleteQuestion: L("Delete this address?", "यह पता हटाएँ?", "हा पत्ता काढायचा?"),
  delete: L("Delete", "हटाएँ", "काढा"),
  keep: L("Keep", "रखें", "ठेवा"),
  cancel: L("Cancel", "रद्द करें", "रद्द करा"),
  pleaseCheck: L("Please check {fields}.", "कृपया {fields} जाँचें।", "कृपया {fields} तपासा."),
  geotag: L(
    "Geo-tag this address (optional but recommended)",
    "इस पते को नक्शे पर लगाएँ (वैकल्पिक, पर ज़रूरी सलाह)",
    "हा पत्ता नकाशावर दाखवा (ऐच्छिक, पण शिफारस केलेले)",
  ),
  pinned: L("Location pinned:", "लोकेशन लगा दी:", "ठिकाण निश्चित केले:"),
  addressType: L("Address type", "पते का प्रकार", "पत्त्याचा प्रकार"),
  labelOptional: L("Label (optional)", "नाम (वैकल्पिक)", "नाव (ऐच्छिक)"),
  labelHint: L("e.g. Mom's flat", "जैसे: माँ का फ़्लैट", "उदा. आईचा फ्लॅट"),
  recipientName: L("Recipient name (optional)", "पाने वाले का नाम (वैकल्पिक)", "घेणाऱ्याचे नाव (ऐच्छिक)"),
  recipientMobile: L("Recipient mobile (optional)", "पाने वाले का मोबाइल (वैकल्पिक)", "घेणाऱ्याचा मोबाइल (ऐच्छिक)"),
  line2: L("Flat / house / floor (optional)", "फ़्लैट / मकान / मंज़िल (वैकल्पिक)", "फ्लॅट / घर / मजला (ऐच्छिक)"),
  landmarkOptional: L("Landmark (optional)", "पहचान का स्थान (वैकल्पिक)", "खूण (ऐच्छिक)"),
  instructions: L("Delivery instructions (optional)", "डिलीवरी निर्देश (वैकल्पिक)", "डिलिव्हरी सूचना (ऐच्छिक)"),
  setDefault: L("Set as default address", "मुख्य पता बनाएँ", "मुख्य पत्ता करा"),
  saving: L("Saving…", "सहेज रहे हैं…", "जतन करत आहे…"),
  save: L("Save address", "पता सहेजें", "पत्ता जतन करा"),
} as const;

const typeText = (type: "HOME" | "WORK" | "OTHER") => (type === "HOME" ? T.home : type === "WORK" ? T.work : T.other);

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

export function AddressManager({ addresses, lang = "en" }: { addresses: AddressRow[]; lang?: Lang }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {addresses.length === 0 && !adding ? (
        <EmptyState title={tr(T.emptyTitle, lang)} description={tr(T.emptyText, lang)} />
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
                lang={lang}
              />
            </Card>
          ) : (
            <AddressCard
              key={address.id}
              address={address}
              onEdit={() => setEditingId(address.id)}
              onDeleted={() => router.refresh()}
              lang={lang}
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
            lang={lang}
          />
        </Card>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          {tr(T.addNew, lang)}
        </Button>
      )}
    </div>
  );
}

function AddressCard({
  address,
  onEdit,
  onDeleted,
  lang = "en",
}: {
  address: AddressRow;
  onEdit: () => void;
  onDeleted: () => void;
  lang?: Lang;
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
      {/* D-148: on a phone the actions sit under the address, so the delete
          confirmation has the card's full width instead of running off its edge. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge tone="neutral">
              {tr(typeText(address.addressType), lang)}
            </Badge>
            {address.label ? (
              <span className="text-sm font-semibold text-ink-900">{address.label}</span>
            ) : null}
            {address.isDefault ? <Badge tone="success">{tr(T.default, lang)}</Badge> : null}
            {address.locationVerified ? <Badge tone="info">{tr(T.mapVerified, lang)}</Badge> : null}
          </div>
          <p className="text-sm text-ink-700">
            {address.line1}
            {address.line2 ? `, ${address.line2}` : ""}
          </p>
          <p className="text-sm text-ink-500">
            {[address.area, address.city].filter(Boolean).join(", ")} — {address.pincode}
          </p>
          {address.landmark ? (
            <p className="text-xs text-ink-500">{tr(T.landmark, lang)} {address.landmark}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            {tr(T.edit, lang)}
          </Button>
          <ConfirmButton
            onConfirm={remove}
            disabled={busy}
            confirmLabel={tr(T.yesDelete, lang)}
            keepLabel={tr(T.keep, lang)}
            question={tr(T.deleteQuestion, lang)}
          >
            {tr(T.delete, lang)}
          </ConfirmButton>
        </div>
      </div>
    </Card>
  );
}

export function AddressForm({
  address,
  onSaved,
  onCancel,
  cancelLabel,
  defaultIsDefault = false,
  lang = "en",
}: {
  address?: AddressRow;
  onSaved: () => void;
  onCancel: () => void;
  cancelLabel?: string;
  lang?: Lang;
  /** Pre-ticks "Set as default address" for a new address. */
  defaultIsDefault?: boolean;
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
  const [isDefault, setIsDefault] = useState(address?.isDefault ?? defaultIsDefault);
  const [coordinates, setCoordinates] = useState<{ latitude: number; longitude: number } | null>(
    address?.latitude && address?.longitude
      ? { latitude: Number(address.latitude), longitude: Number(address.longitude) }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TC-FLD-125: the server's field messages, shown on the field they belong to.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

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
      const fields = (payload?.error?.details?.fields ?? {}) as Record<string, string>;
      setFieldErrors(fields);
      const named = Object.keys(fields).filter((f) => FIELD_LABELS[f]);
      setError(
        named.length
          ? tr(T.pleaseCheck, lang).replace("{fields}", named.map((f) => tr(FIELD_LABELS[f], lang)).join(", "))
          : errorText(payload?.error?.message ?? "Could not save this address.", lang, payload?.error?.code),
      );
      return;
    }
    setFieldErrors({});
    onSaved();
  }

  return (
    <form className="grid gap-4" onSubmit={save}>
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
          {tr(T.geotag, lang)}
        </p>
        <MapPicker
          purpose="address_save"
          initialCoordinates={coordinates}
          onConfirm={handleMapConfirm}
        />
        {coordinates ? (
          <p className="mt-1 text-xs text-leaf-700" data-testid="address-geotag">
            {tr(T.pinned, lang)} {coordinates.latitude.toFixed(5)}, {coordinates.longitude.toFixed(5)}
          </p>
        ) : null}
      </div>

      <Field label={tr(T.addressType, lang)}>
        <div className="flex gap-2" role="radiogroup" aria-label={tr(T.addressType, lang)}>
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
              {tr(typeText(type), lang)}
            </button>
          ))}
        </div>
      </Field>
      <Field label={tr(T.labelOptional, lang)} hint={tr(T.labelHint, lang)} error={fieldErrors.label}>
        <input className={inputClass} value={label} maxLength={50} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr(T.recipientName, lang)} error={fieldErrors.recipientName}>
          <input className={inputClass} value={recipientName} maxLength={100} onChange={(e) => setRecipientName(e.target.value)} />
        </Field>
        <Field label={tr(T.recipientMobile, lang)} error={fieldErrors.recipientPhone}>
          <input
            className={inputClass}
            value={recipientPhone}
            onChange={(e) => setRecipientPhone(mobileFieldDigits(e.target.value))}
            inputMode="numeric"
            pattern="[6-9]\d{9}"
          />
        </Field>
      </div>
      <Field label={tr(FIELD_LABELS.line1, lang)} error={fieldErrors.line1}>
        <input
          className={inputClass}
          maxLength={200}
          value={line1}
          onChange={(e) => setLine1(e.target.value)}
          required
        />
      </Field>
      <Field label={tr(T.line2, lang)} error={fieldErrors.line2}>
        <input className={inputClass} value={line2} maxLength={200} onChange={(e) => setLine2(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr(FIELD_LABELS.area, lang)} error={fieldErrors.area}>
          <input className={inputClass} value={area} maxLength={100} onChange={(e) => setArea(e.target.value)} />
        </Field>
        <Field label={tr(FIELD_LABELS.city, lang)} error={fieldErrors.city}>
          <input
            className={inputClass}
            maxLength={100}
            value={city}
            onChange={(e) => setCity(e.target.value)}
            required
          />
        </Field>
        <Field label={tr(FIELD_LABELS.state, lang)} error={fieldErrors.state}>
          <input className={inputClass} value={state} maxLength={100} onChange={(e) => setState(e.target.value)} />
        </Field>
        <Field label={tr(FIELD_LABELS.pincode, lang)} error={fieldErrors.pincode}>
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
      <Field label={tr(T.landmarkOptional, lang)} error={fieldErrors.landmark}>
        <input
          className={inputClass}
          maxLength={200}
          value={landmark}
          onChange={(e) => setLandmark(e.target.value)}
        />
      </Field>
      <Field label={tr(T.instructions, lang)} error={fieldErrors.deliveryInstructions}>
        <textarea
          className={inputClass}
          rows={2}
          maxLength={500}
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
        {tr(T.setDefault, lang)}
      </label>

      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? tr(T.saving, lang) : tr(T.save, lang)}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {cancelLabel ?? tr(T.cancel, lang)}
        </Button>
      </div>
    </form>
  );
}
