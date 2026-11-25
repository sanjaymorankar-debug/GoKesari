"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";

type Audience = "customers" | "shopOwners";

/** Admin → Sign-in security data (src/server/otp/sign-in-security.ts), dates as ISO strings. */
export interface SignInSecurityData {
  provider: { mode: "none" | "mock" | "msg91"; configured: string; problem: string | null; ruleSmsEnabled: boolean; available: boolean };
  audiences: {
    audience: Audience;
    flag: string;
    label: string;
    enabled: boolean;
    inForce: boolean;
    lastChange: { byEmail: string | null; at: string; reason: string; enabled: boolean } | null;
  }[];
  checkout: { enabled: boolean; mode: "every_checkout" | "once_per_hours"; hours: number; inForce: boolean };
  stats: {
    customers: { total: number; verifiedMobile: number };
    shopOwners: { total: number; verifiedMobile: number };
    lockouts24h: number;
    lockouts7d: number;
    smsCodesSent24h: number;
  };
}

type Tab = "sms" | "checkout" | "status";
const TABS: { key: Tab; label: string }[] = [
  { key: "sms", label: "SMS sign-in code" },
  { key: "checkout", label: "Checkout code" },
  { key: "status", label: "Status" },
];

const ist = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST";

const PROVIDER_LABEL: Record<SignInSecurityData["provider"]["mode"], string> = {
  none: "none — SMS codes cannot be sent",
  mock: "mock — codes go to Admin → Test messages (test site only)",
  msg91: "MSG91 configured (DLT template)",
};

function ProviderLine({ provider }: { provider: SignInSecurityData["provider"] }) {
  return (
    <Alert tone={provider.available ? "success" : "warning"} title="SMS provider">
      <span data-testid="sms-provider-status">
        {PROVIDER_LABEL[provider.mode]}
        {provider.problem ? ` — ${provider.problem}` : ""}
        {!provider.available ? " Switches below stay saved, but nobody is asked for an SMS code until SMS works: sign-in stays email-only." : ""}
      </span>
    </Alert>
  );
}

function AudienceSwitch({ row, onSaved }: { row: SignInSecurityData["audiences"][number]; onSaved: (message: string) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/admin/sign-in-security", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "audience", audience: row.audience, enabled: !row.enabled, reason }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy(false);
    if (!response?.ok) return setError(payload?.error?.message ?? "Could not save.");
    setReason("");
    onSaved(response.status === 202 ? "Sent for a second admin's approval (Admin → Approvals)." : `${row.label}: ${row.enabled ? "off" : "on"}.`);
  }

  return (
    <Card className="space-y-2 p-4" data-testid={`sms-switch-${row.audience}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-ink-900">{row.label}</p>
        <Badge tone={row.inForce ? "success" : row.enabled ? "warning" : "neutral"}>
          {row.inForce ? "On" : row.enabled ? "On — not in force (no SMS)" : "Off (email only)"}
        </Badge>
      </div>
      <p className="text-xs text-ink-500">
        {row.lastChange
          ? `Last changed ${ist(row.lastChange.at)} by ${row.lastChange.byEmail ?? "unknown"} — “${row.lastChange.reason}”`
          : "Never changed (seeded off)."}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required)"
          aria-label={`Reason for switching ${row.label}`}
          className={`${inputClass} flex-1`}
        />
        <Button type="button" disabled={busy || reason.trim().length < 5} onClick={save}>
          {busy ? "Saving…" : row.enabled ? "Switch off" : "Switch on"}
        </Button>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Card>
  );
}

function CheckoutForm({ checkout, onSaved }: { checkout: SignInSecurityData["checkout"]; onSaved: (message: string) => void }) {
  const [enabled, setEnabled] = useState(checkout.enabled);
  const [mode, setMode] = useState(checkout.mode);
  const [hours, setHours] = useState(String(checkout.hours));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch("/api/admin/sign-in-security", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "checkout", enabled, mode, hours: Number(hours) }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy(false);
    if (!response?.ok) return setError(payload?.error?.message ?? "Could not save.");
    onSaved("Checkout code saved.");
  }

  return (
    <Card className="p-4" data-testid="checkout-code-form">
      <form className="space-y-3" onSubmit={save}>
        <p className="text-sm text-ink-600">
          Before placing an order the customer enters a code sent by SMS to their verified mobile (an account without one verifies it in the same step).
          Status now: <strong>{checkout.inForce ? "in force" : checkout.enabled ? "on, but not in force (no SMS)" : "off"}</strong>.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Ask for a code at checkout
        </label>
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium text-ink-700">How often</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="mode" checked={mode === "every_checkout"} onChange={() => setMode("every_checkout")} /> Every order (a code is good for one order, 10 minutes)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="mode" checked={mode === "once_per_hours"} onChange={() => setMode("once_per_hours")} /> Once every
            <input
              type="number"
              min={1}
              max={720}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              aria-label="Hours one code covers"
              className={`${inputClass} w-20`}
            />
            hours
          </label>
        </fieldset>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </form>
    </Card>
  );
}

export function SignInSecurityPanel({ data, initialTab }: { data: SignInSecurityData; initialTab: Tab }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [notice, setNotice] = useState<string | null>(null);
  const saved = (message: string) => {
    setNotice(message);
    router.refresh();
  };
  const pct = (a: { total: number; verifiedMobile: number }) => (a.total ? Math.round((a.verifiedMobile / a.total) * 100) : 0);

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Sign-in security" className="flex flex-wrap gap-2 border-b border-cream-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`min-h-11 px-3 text-sm font-semibold ${tab === t.key ? "border-b-2 border-kesari-600 text-kesari-800" : "text-ink-600"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <ProviderLine provider={data.provider} />

      {tab === "sms" ? (
        <div className="space-y-3" role="tabpanel">
          {data.audiences.map((row) => (
            <AudienceSwitch key={row.audience} row={row} onSaved={saved} />
          ))}
          <p className="text-xs text-ink-500">
            Off: that audience signs in with the emailed code only, from the next sign-in; verified mobiles stay verified. Other roles (admins, riders, dealers, staff) never get the SMS step.
          </p>
        </div>
      ) : null}

      {tab === "checkout" ? (
        <div role="tabpanel">
          <CheckoutForm checkout={data.checkout} onSaved={saved} />
        </div>
      ) : null}

      {tab === "status" ? (
        <Card className="p-4" role="tabpanel" data-testid="sign-in-security-status">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-500">Customers with a verified mobile</dt>
              <dd className="text-lg font-semibold">
                {data.stats.customers.verifiedMobile} / {data.stats.customers.total} ({pct(data.stats.customers)}%)
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">Shop owners with a verified mobile</dt>
              <dd className="text-lg font-semibold">
                {data.stats.shopOwners.verifiedMobile} / {data.stats.shopOwners.total} ({pct(data.stats.shopOwners)}%)
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">Codes locked after too many wrong tries (24 h / 7 days)</dt>
              <dd className="text-lg font-semibold">
                {data.stats.lockouts24h} / {data.stats.lockouts7d}
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">SMS codes sent (sign-in + checkout, 24 h)</dt>
              <dd className="text-lg font-semibold">{data.stats.smsCodesSent24h}</dd>
            </div>
          </dl>
        </Card>
      ) : null}
    </div>
  );
}
