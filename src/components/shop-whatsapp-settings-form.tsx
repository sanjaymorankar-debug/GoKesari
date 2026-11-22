"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

/**
 * New orders on WhatsApp (docs/smart-shopping-2026-11/FEATURE3_WHATSAPP_ORDERS.md):
 * the shop owner's switch, their own number (prefilled with the shop's
 * WhatsApp number) and up to N staff numbers. Each saved number gets a test
 * message; it gets orders once WhatsApp reports it delivered.
 */
export interface WhatsAppContactProps {
  id: string;
  phoneE164: string;
  label: string | null;
  optedIn: boolean;
  status: "UNCHECKED" | "CHECKING" | "ACTIVE" | "NOT_ON_WHATSAPP";
  statusLabel: string;
  lastError: string | null;
}

export interface ShopWhatsAppSettingsProps {
  shopId: string;
  enabled: boolean;
  live: boolean;
  notLiveReason: string | null;
  maxStaffNumbers: number;
  shopWhatsappNumber: string | null;
  owner: WhatsAppContactProps | null;
  staff: WhatsAppContactProps[];
}

const national = (e164: string | null | undefined) => (e164 ? e164.replace(/^\+91/, "") : "");

const TONES = { ACTIVE: "success", NOT_ON_WHATSAPP: "danger", CHECKING: "info", UNCHECKED: "neutral" } as const;

function StatusBadge({ contact }: { contact: WhatsAppContactProps | null | undefined }) {
  if (!contact) return null;
  return <Badge tone={TONES[contact.status]}>{contact.statusLabel}</Badge>;
}

export function ShopWhatsAppSettingsForm({ initial }: { initial: ShopWhatsAppSettingsProps }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [ownerPhone, setOwnerPhone] = useState(national(initial.owner?.phoneE164 ?? initial.shopWhatsappNumber));
  const [ownerOptIn, setOwnerOptIn] = useState(initial.owner?.optedIn ?? true);
  const [staff, setStaff] = useState(initial.staff.map((s) => ({ phone: national(s.phoneE164), label: s.label ?? "" })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const byPhone = new Map([...(initial.owner ? [initial.owner] : []), ...initial.staff].map((c) => [national(c.phoneE164), c]));

  async function send(method: "PUT" | "POST", body: unknown, done: (payload: { checksQueued?: number }) => string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const response = await fetch(`/api/shops/${initial.shopId}/whatsapp`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setError(payload?.error?.message ?? "Could not save your WhatsApp settings.");
      return;
    }
    setNotice(done(payload ?? {}));
    router.refresh();
  }

  function save() {
    void send(
      "PUT",
      {
        enabled,
        owner: ownerPhone.trim() ? { phone: ownerPhone, optedIn: ownerOptIn } : null,
        staff: staff.filter((s) => s.phone.trim()).map((s) => ({ phone: s.phone, label: s.label || null })),
      },
      (p) => (p.checksQueued ? `Saved. A test message is on its way to ${p.checksQueued} number(s); the status below changes when WhatsApp delivers it.` : "Saved."),
    );
  }

  return (
    <Card className="space-y-4 p-4" data-testid="shop-whatsapp-settings">
      {!initial.live && initial.notLiveReason ? <Alert tone="info">{initial.notLiveReason}</Alert> : null}

      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1 h-5 w-5" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="whatsapp-enabled" />
        <span>
          <span className="block font-medium text-ink-900">Send new orders to WhatsApp</span>
          <span className="block text-ink-600">
            Each new order comes with Accept and Reject buttons. The first tap wins — on any of your numbers or in the app — and the others are told who
            answered.
          </span>
        </span>
      </label>

      <div className="space-y-2">
        <Field label={<span className="flex flex-wrap items-center gap-2">Your WhatsApp number <StatusBadge contact={byPhone.get(ownerPhone.trim())} /></span>} hint="Prefilled with your shop's WhatsApp number.">
          <input className={inputClass} inputMode="numeric" placeholder="10-digit mobile" value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} data-testid="whatsapp-owner-phone" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={ownerOptIn} onChange={(e) => setOwnerOptIn(e.target.checked)} />I agree to get order alerts from GoKesari on this WhatsApp number.
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-ink-700">
          Staff numbers (up to {initial.maxStaffNumbers}) — they can accept or reject orders too
        </p>
        {staff.map((s, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-center">
            <input
              className={inputClass}
              placeholder="Name (shown as who accepted)"
              value={s.label}
              onChange={(e) => setStaff(staff.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            />
            <input
              className={inputClass}
              inputMode="numeric"
              placeholder="10-digit mobile"
              value={s.phone}
              onChange={(e) => setStaff(staff.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))}
            />
            <span className="flex items-center gap-2">
              <StatusBadge contact={byPhone.get(s.phone.trim())} />
              <Button size="sm" variant="ghost" onClick={() => setStaff(staff.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </span>
          </div>
        ))}
        {staff.length < initial.maxStaffNumbers ? (
          <Button size="sm" variant="secondary" onClick={() => setStaff([...staff, { phone: "", label: "" }])}>
            Add a staff number
          </Button>
        ) : null}
      </div>

      {[...(initial.owner ? [initial.owner] : []), ...initial.staff]
        .filter((c) => c.status === "NOT_ON_WHATSAPP" || c.status === "CHECKING")
        .map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-2 text-sm text-ink-700">
            <span>
              {c.phoneE164}: {c.statusLabel}
              {c.lastError ? ` (${c.lastError})` : ""}
            </span>
            <Button size="sm" variant="secondary" disabled={busy || !initial.live} onClick={() => void send("POST", { action: "recheck", contactId: c.id }, () => "Test message sent again.")}>
              Check again
            </Button>
          </div>
        ))}

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Button disabled={busy} onClick={save} data-testid="whatsapp-save">
        Save WhatsApp settings
      </Button>
    </Card>
  );
}
