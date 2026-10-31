"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { REGISTRATION_MESSAGES, RIDER_GENDERS, VEHICLES_WITHOUT_NUMBER } from "@/lib/gig/registration";
import { VEHICLE_TYPES } from "@/lib/vehicle-types";

type LocationState =
  | { kind: "none" }
  | { kind: "asking" }
  | { kind: "shared"; latitude: number; longitude: number; accuracyM: number | null }
  | { kind: "denied"; message: string };

/** Why the browser or phone gave no position, in words the partner can act on. */
function locationErrorMessage(error: GeolocationPositionError | null): string {
  if (error?.code === 1) {
    return "Location access is blocked. Allow location for GoKesari in your browser or phone settings, then tap \"Share my location\" again. Registration can't be completed without it.";
  }
  if (error?.code === 3) return "Finding your location took too long. Move to an open spot and try again.";
  return "We couldn't read your location. Turn on location (GPS) and try again.";
}

/**
 * Gig worker flow, features 1 and 4: personal details, address, vehicle and
 * emergency contact, and the device's current location — the form can't be
 * submitted until location is shared. PAN and Aadhaar are verified on the
 * next step (/delivery-partner/kyc), never typed here.
 */
export function DeliveryPartnerRegisterForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [vehicleType, setVehicleType] = useState("");
  const [location, setLocation] = useState<LocationState>({ kind: "none" });

  function shareLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocation({ kind: "denied", message: "This browser can't share a location. Open GoKesari in the app or in Chrome / Safari." });
      return;
    }
    setLocation({ kind: "asking" });
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setLocation({
          kind: "shared",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
        }),
      (geoError) => setLocation({ kind: "denied", message: locationErrorMessage(geoError) }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }

  // A submit handler, not <form action>: React resets a form after its action runs, which would
  // wipe everything the partner typed whenever the server refuses a field.
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    setFieldErrors({});
    if (location.kind !== "shared") {
      setError(REGISTRATION_MESSAGES.location);
      setFieldErrors({ location: REGISTRATION_MESSAGES.location });
      return;
    }
    setBusy(true);

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
        gender: get("gender") || null,
        addressLine: get("addressLine") || null,
        addressCity: get("addressCity") || null,
        addressPincode: get("addressPincode") || null,
        emergencyContactName: get("emergencyContactName") || null,
        emergencyContactMobile: get("emergencyContactMobile") || null,
        emergencyContactRelation: get("emergencyContactRelation") || null,
        bankAccountHolderName: get("bankAccountHolderName") || null,
        bankAccountNumber: get("bankAccountNumber") || null,
        bankIfsc: get("bankIfsc") || null,
        vehicleType: get("vehicleType"),
        vehicleRegistrationNumber: get("vehicleRegistrationNumber") || null,
        drivingLicenceNumber: get("drivingLicenceNumber") || null,
        latitude: location.latitude,
        longitude: location.longitude,
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
    // Next step: PAN and Aadhaar verification.
    router.push("/delivery-partner/kyc");
    router.refresh();
  }

  const needsNumber = vehicleType !== "" && !VEHICLES_WITHOUT_NUMBER.includes(vehicleType);

  return (
    <Card className="p-6">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Personal details</h2>
        </div>

        <Field label="Full name" error={fieldErrors.fullName}>
          <input name="fullName" required autoComplete="name" className={inputClass} />
        </Field>
        <Field label="Mobile number" hint="10-digit Indian mobile number" error={fieldErrors.mobile}>
          <input name="mobile" required inputMode="numeric" autoComplete="tel-national" pattern="[6-9][0-9]{9}" maxLength={10} className={inputClass} />
        </Field>
        <Field label="Email" error={fieldErrors.email}>
          <input name="email" type="email" required autoComplete="email" className={inputClass} />
        </Field>
        <Field label="Date of birth" hint="You must be 18 or older" error={fieldErrors.dateOfBirth}>
          <input name="dateOfBirth" type="date" required autoComplete="bday" className={inputClass} />
        </Field>
        <Field label="Gender" error={fieldErrors.gender}>
          <select name="gender" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Select
            </option>
            {RIDER_GENDERS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </Field>
        <div />

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Address</h2>
        </div>
        <div className="sm:col-span-2">
          <Field label="House, street and area" error={fieldErrors.addressLine}>
            <input name="addressLine" required autoComplete="street-address" className={inputClass} />
          </Field>
        </div>
        <Field label="City" error={fieldErrors.addressCity}>
          <input name="addressCity" required autoComplete="address-level2" className={inputClass} />
        </Field>
        <Field label="PIN code" error={fieldErrors.addressPincode}>
          <input name="addressPincode" required inputMode="numeric" autoComplete="postal-code" maxLength={6} className={inputClass} />
        </Field>

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Vehicle</h2>
        </div>
        <Field label="Vehicle type" error={fieldErrors.vehicleType}>
          <select name="vehicleType" required value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} className={inputClass}>
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
        <Field
          label={needsNumber ? "Vehicle registration number" : "Vehicle registration number (if any)"}
          hint="e.g. MH12 AB 1234"
          error={fieldErrors.vehicleRegistrationNumber}
        >
          <input name="vehicleRegistrationNumber" required={needsNumber} autoCapitalize="characters" className={inputClass} />
        </Field>
        <Field label="Driving licence number (optional)">
          <input name="drivingLicenceNumber" className={inputClass} />
        </Field>
        <div />

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Emergency contact</h2>
        </div>
        <Field label="Name" error={fieldErrors.emergencyContactName}>
          <input name="emergencyContactName" required className={inputClass} />
        </Field>
        <Field label="Mobile number" error={fieldErrors.emergencyContactMobile}>
          <input name="emergencyContactMobile" required inputMode="numeric" maxLength={10} className={inputClass} />
        </Field>
        <Field label="Relation (optional)" hint="e.g. Father, Spouse">
          <input name="emergencyContactRelation" className={inputClass} />
        </Field>
        <div />

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Bank details (optional — can be added later)</h2>
        </div>
        <Field label="Account holder name">
          <input name="bankAccountHolderName" className={inputClass} />
        </Field>
        <Field label="Account number" error={fieldErrors.bankAccountNumber}>
          <input name="bankAccountNumber" inputMode="numeric" className={inputClass} />
        </Field>
        <Field label="IFSC" error={fieldErrors.bankIfsc}>
          <input name="bankIfsc" autoCapitalize="characters" className={inputClass} />
        </Field>
        <div />

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-500">Your location</h2>
          <p className="mb-3 text-sm text-ink-500">
            GoKesari needs your current location to finish registration and to find deliveries near you. Your phone
            or browser will ask for permission.
          </p>
          <Button type="button" variant="secondary" onClick={shareLocation} disabled={location.kind === "asking"}>
            {location.kind === "asking" ? "Finding your location…" : location.kind === "shared" ? "Share again" : "Share my location"}
          </Button>
          {location.kind === "shared" ? (
            <p className="mt-2 text-sm text-leaf-700" data-testid="location-shared">
              Location shared ({location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
              {location.accuracyM != null ? `, within about ${location.accuracyM} m` : ""}).
            </p>
          ) : null}
          {location.kind === "denied" ? (
            <div className="mt-2">
              <Alert tone="danger">{location.message}</Alert>
            </div>
          ) : null}
          {fieldErrors.location && location.kind !== "denied" && location.kind !== "shared" ? (
            <p className="mt-2 text-sm text-red-700">{fieldErrors.location}</p>
          ) : null}
        </div>

        <Field label="Preferred operating radius (km)">
          <input name="operatingRadiusKm" type="number" min={1} max={50} defaultValue={5} className={inputClass} />
        </Field>

        {error ? (
          <div className="sm:col-span-2">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}

        <div className="sm:col-span-2">
          <Button type="submit" size="lg" disabled={busy || location.kind !== "shared"} className="w-full">
            {busy ? "Submitting…" : location.kind === "shared" ? "Submit and continue to KYC" : "Share your location to continue"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
