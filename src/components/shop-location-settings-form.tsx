"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { MapPicker, type MapPickerResult } from "@/components/map-picker";

export interface ShopLocationSettings {
  shopId: string;
  latitude: string | null;
  longitude: string | null;
  locationVerified: boolean;
  pickupLatitude: string | null;
  pickupLongitude: string | null;
  pickupInstructions: string | null;
  serviceRadiusKm: number;
}

/**
 * Post-registration location editing (§2, §5) — the main shop location (with
 * re-verification if the pin moves) and an independent pickup point, since
 * the actual pickup spot can differ from the shop's storefront address.
 */
export function ShopLocationSettingsForm({ settings }: { settings: ShopLocationSettings }) {
  const router = useRouter();
  const [mainCoordinates, setMainCoordinates] = useState<{ latitude: number; longitude: number } | null>(
    settings.latitude && settings.longitude
      ? { latitude: Number(settings.latitude), longitude: Number(settings.longitude) }
      : null,
  );
  const [pickupCoordinates, setPickupCoordinates] = useState<{ latitude: number; longitude: number } | null>(
    settings.pickupLatitude && settings.pickupLongitude
      ? { latitude: Number(settings.pickupLatitude), longitude: Number(settings.pickupLongitude) }
      : null,
  );
  const [pickupInstructions, setPickupInstructions] = useState(settings.pickupInstructions ?? "");
  const [serviceRadiusKm, setServiceRadiusKm] = useState(String(settings.serviceRadiusKm));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);

    const response = await fetch(`/api/shops/${settings.shopId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        latitude: mainCoordinates ? String(mainCoordinates.latitude) : null,
        longitude: mainCoordinates ? String(mainCoordinates.longitude) : null,
        pickupLatitude: pickupCoordinates ? String(pickupCoordinates.latitude) : null,
        pickupLongitude: pickupCoordinates ? String(pickupCoordinates.longitude) : null,
        pickupInstructions: pickupInstructions || null,
        serviceRadiusKm: Number(serviceRadiusKm),
      }),
    });
    setBusy(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not save the location.");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-ink-900">Location</h2>
        {settings.locationVerified ? (
          <Badge tone="success">Verified</Badge>
        ) : (
          <Badge tone="warning">Not verified</Badge>
        )}
      </div>
      <p className="mb-3 text-sm text-ink-500">
        Used for customer search and delivery. Re-confirming moves the pin — the
        old location stops being used for new orders once you save.
      </p>

      <div className="space-y-4">
        <div>
          <p className="mb-2 text-sm font-medium text-ink-700">Shop location</p>
          <MapPicker
            purpose="shop_location_update"
            initialCoordinates={mainCoordinates}
            onConfirm={(result: MapPickerResult) =>
              setMainCoordinates({ latitude: result.latitude, longitude: result.longitude })
            }
          />
        </div>

        <div className="border-t border-cream-200 pt-4">
          <Field label="Delivery radius (km)">
            <input
              className={inputClass}
              type="number"
              min={1}
              max={50}
              step={1}
              value={serviceRadiusKm}
              onChange={(e) => setServiceRadiusKm(e.target.value)}
              data-testid="service-radius"
            />
          </Field>
          <p className="mt-1 text-xs text-ink-500">
            Customers further than this from your shop location will not see you
            as delivering to them.
          </p>
        </div>

        <div className="border-t border-cream-200 pt-4">
          <p className="mb-1 text-sm font-medium text-ink-700">Pickup point (optional)</p>
          <p className="mb-2 text-xs text-ink-500">
            Only set this if where a delivery partner should actually collect
            orders differs from the shop location above — e.g. a service
            entrance or a different gate.
          </p>
          <MapPicker
            purpose="shop_pickup_point"
            initialCoordinates={pickupCoordinates}
            onConfirm={(result: MapPickerResult) =>
              setPickupCoordinates({ latitude: result.latitude, longitude: result.longitude })
            }
          />
          <div className="mt-3">
            <Field label="Pickup instructions (optional)">
              <input
                className={inputClass}
                value={pickupInstructions}
                onChange={(e) => setPickupInstructions(e.target.value)}
                placeholder="e.g. Service entrance, Gate 3"
              />
            </Field>
          </div>
        </div>
      </div>

      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-3">
        <Button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save location"}
        </Button>
        {saved ? <span className="text-xs text-leaf-700">Saved.</span> : null}
      </div>
    </Card>
  );
}
