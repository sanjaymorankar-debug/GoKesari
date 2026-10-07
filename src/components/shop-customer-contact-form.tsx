"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card } from "@/components/ui";

/**
 * C1: the phone and WhatsApp numbers customers see for this shop. Only these
 * are shown to customers — the registration phone and the owner's login
 * number stay private. Leaving both blank shows GoKesari customer care.
 */
export function ShopCustomerContactForm({
  shopId,
  initial,
}: {
  shopId: string;
  initial: { contactPhone: string | null; whatsappNumber: string | null };
}) {
  const router = useRouter();
  const [contactPhone, setContactPhone] = useState(initial.contactPhone ?? "");
  const [whatsappNumber, setWhatsappNumber] = useState(initial.whatsappNumber ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const clean = (v: string) => v.replace(/[\s-]/g, "") || null;
    const response = await fetch(`/api/shops/${shopId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactPhone: clean(contactPhone), whatsappNumber: clean(whatsappNumber) }),
    });
    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not save the contact numbers.");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  const inputClass = "w-full rounded-lg border border-cream-200 px-3 py-2 text-sm";
  return (
    <Card className="p-4" data-testid="shop-customer-contact">
      <h2 className="mb-1 text-lg font-semibold text-ink-900">Customer contact</h2>
      <p className="mb-3 text-sm text-ink-500">
        The numbers customers see on your shop page. Your registration and login numbers are never shown to
        customers. Leave both blank to send customers to GoKesari customer care.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-ink-700">Shop contact phone</span>
          <input
            className={inputClass}
            inputMode="numeric"
            placeholder="10-digit mobile"
            value={contactPhone}
            onChange={(e) => {
              setContactPhone(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-ink-700">WhatsApp number</span>
          <input
            className={inputClass}
            inputMode="numeric"
            placeholder="10-digit mobile"
            value={whatsappNumber}
            onChange={(e) => {
              setWhatsappNumber(e.target.value);
              setSaved(false);
            }}
          />
        </label>
      </div>
      <div className="mt-3 space-y-2">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {saved ? <Alert tone="success">Saved.</Alert> : null}
      </div>
      <div className="mt-3">
        <Button size="sm" disabled={busy} onClick={save}>
          Save contact numbers
        </Button>
      </div>
    </Card>
  );
}
