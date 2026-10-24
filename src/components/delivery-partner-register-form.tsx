"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { MapPicker, type MapPickerResult } from "@/components/map-picker";
import { VEHICLE_TYPES } from "@/lib/vehicle-types";

export function DeliveryPartnerRegisterForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [coordinates, setCoordinates] = useState<{ latitude: number; longitude: number } | null>(
    null,
  );

  function handleMapConfirm(result: MapPickerResult) {
    setCoordinates({ latitude: result.latitude, longitude: result.longitude });
  }

  async function submit(formData: FormData) {
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const get = (key: string) => String(formData.get(key) ?? "").trim();
    const radius = get("operatingRadiusKm");

    const response = await fetch("/api/delivery-partner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: get("fullName"),
        mobile: get("mobile"),
        email: get("email") || null,
        dateOfBirth: get("dateOfBirth") || null,
        panNumber: get("panNumber") || null,
        governmentIdType: get("governmentIdType") || null,
        governmentIdNumber: get("governmentIdNumber") || null,
        bankAccountHolderName: get("bankAccountHolderName") || null,
        bankAccountNumber: get("bankAccountNumber") || null,
        bankIfsc: get("bankIfsc") || null,
        vehicleType: get("vehicleType"),
        vehicleRegistrationNumber: get("vehicleRegistrationNumber") || null,
        drivingLicenceNumber: get("drivingLicenceNumber") || null,
        latitude: coordinates?.latitude ?? null,
        longitude: coordinates?.longitude ?? null,
        operatingRadiusKm: radius ? Number(radius) : undefined,
      }),
    });

    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      const fields = payload?.error?.details?.fields;
      if (fields && typeof fields === "object") setFieldErrors(fields);
      setError(payload?.error?.message ?? "Could not submit your application.");
      return;
    }
    router.push("/delivery-partner");
    router.refresh();
  }

  return (
    <Card className="p-6">
      <form action={submit} className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Personal information
          </h2>
        </div>

        <Field label="Full name" error={fieldErrors.fullName}>
          <input name="fullName" required className={inputClass} />
        </Field>
        <Field label="Mobile number" hint="10-digit Indian mobile number" error={fieldErrors.mobile}>
          <input
            name="mobile"
            required
            inputMode="numeric"
            pattern="[6-9][0-9]{9}"
            className={inputClass}
          />
        </Field>
        <Field label="Email (optional)">
          <input name="email" type="email" className={inputClass} />
        </Field>
        <Field label="Date of birth (optional)">
          <input name="dateOfBirth" type="date" className={inputClass} />
        </Field>

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Identity &amp; bank details (optional — can be added later)
          </h2>
        </div>

        {/* TC-FLD-092/093: the server's message for a bad PAN, ID, account, IFSC or vehicle number shows on its field. */}
        <Field label="PAN (optional)" error={fieldErrors.panNumber}>
          <input name="panNumber" autoCapitalize="characters" className={inputClass} />
        </Field>
        <Field label="Government ID type (optional)" hint="e.g. Aadhaar, Voter ID">
          <input name="governmentIdType" className={inputClass} />
        </Field>
        <Field label="Government ID number (optional)" error={fieldErrors.governmentIdNumber}>
          <input name="governmentIdNumber" className={inputClass} />
        </Field>
        <div />
        <Field label="Bank account holder name (optional)">
          <input name="bankAccountHolderName" className={inputClass} />
        </Field>
        <Field label="Bank account number (optional)" error={fieldErrors.bankAccountNumber}>
          <input name="bankAccountNumber" inputMode="numeric" className={inputClass} />
        </Field>
        <Field label="Bank IFSC (optional)" error={fieldErrors.bankIfsc}>
          <input name="bankIfsc" autoCapitalize="characters" className={inputClass} />
        </Field>

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Vehicle
          </h2>
        </div>

        <Field label="Vehicle type" error={fieldErrors.vehicleType}>
          <select name="vehicleType" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Select a vehicle type
            </option>
            {VEHICLE_TYPES.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Vehicle registration number (optional)" hint="e.g. MH12 AB 1234" error={fieldErrors.vehicleRegistrationNumber}>
          <input name="vehicleRegistrationNumber" autoCapitalize="characters" className={inputClass} />
        </Field>
        <Field label="Driving licence number (optional)">
          <input name="drivingLicenceNumber" className={inputClass} />
        </Field>
        <div />

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">
            Preferred operating area (optional)
          </h2>
          <MapPicker
            purpose="delivery_partner_registration"
            initialCoordinates={coordinates}
            onConfirm={handleMapConfirm}
          />
          {coordinates ? (
            <p className="mt-1 text-xs text-leaf-700">Location pinned and confirmed.</p>
          ) : null}
        </div>

        <Field label="Preferred operating radius (km)">
          <input
            name="operatingRadiusKm"
            type="number"
            min={1}
            max={100}
            defaultValue={5}
            className={inputClass}
          />
        </Field>

        {error ? (
          <div className="sm:col-span-2">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}

        <div className="sm:col-span-2">
          <Button type="submit" size="lg" disabled={busy} className="w-full">
            {busy ? "Submitting…" : "Submit application"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
