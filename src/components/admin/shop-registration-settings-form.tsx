"use client";

/** Admin → Unpaid & expiring registrations → Settings (0203). Saves both rules through one audited endpoint. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, inputClass } from "@/components/ui";

interface Membership {
  periodMonths: number;
  graceDays: number;
  reminderDays: number;
  remindersEnabled: boolean;
  renewalCheckoutEnabled: boolean;
  renewalWindowDays: number;
}

interface Subscription {
  reminderHourIst: number;
  unpaidReminderDays: number[];
  unpaidRepeatEveryDays: number;
  expiryReminderDays: number[];
  graceDaily: boolean;
  autoCreateLink: boolean;
  paymentLinkValidityDays: number;
  ccEmails: string[];
  renewalFeeByShopType: Record<string, number>;
  payCommissionOnRenewals: boolean;
}

const list = (v: string) =>
  v
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
const days = (v: string) => [...new Set(list(v).map(Number).filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => b - a);

export function ShopRegistrationSettingsForm({
  membership,
  subscription,
  shopTypes,
  feeRuleSummary,
}: {
  membership: Membership;
  subscription: Subscription;
  shopTypes: { key: string; label: string }[];
  feeRuleSummary: string | null;
}) {
  const router = useRouter();
  const [m, setM] = useState({ ...membership });
  const [s, setS] = useState({
    ...subscription,
    unpaidText: subscription.unpaidReminderDays.join(", "),
    expiryText: subscription.expiryReminderDays.join(", "),
    ccText: subscription.ccEmails.join(", "),
    fees: Object.fromEntries(shopTypes.map((t) => [t.key, subscription.renewalFeeByShopType[t.key] ? String(subscription.renewalFeeByShopType[t.key] / 100) : ""])) as Record<string, string>,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== "" ? Math.round(Number(v)) : fallback);

  async function save() {
    setBusy(true);
    setMessage(null);
    const renewalFeeByShopType: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.fees)) {
      const rupees = Number(v);
      if (v.trim() && Number.isFinite(rupees) && rupees > 0) renewalFeeByShopType[k] = Math.round(rupees * 100);
    }
    const res = await fetch("/api/admin/registration-subscription/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        membership: m,
        subscription: {
          reminderHourIst: s.reminderHourIst,
          unpaidReminderDays: days(s.unpaidText),
          unpaidRepeatEveryDays: s.unpaidRepeatEveryDays,
          expiryReminderDays: days(s.expiryText),
          graceDaily: s.graceDaily,
          autoCreateLink: s.autoCreateLink,
          paymentLinkValidityDays: s.paymentLinkValidityDays,
          ccEmails: list(s.ccText),
          renewalFeeByShopType,
          payCommissionOnRenewals: s.payCommissionOnRenewals,
        },
      }),
    });
    setBusy(false);
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; details?: unknown } };
    if (!res.ok) {
      setMessage({ tone: "danger", text: `${json.error?.message ?? "Not saved"} ${json.error?.details ? JSON.stringify(json.error.details) : ""}` });
      return;
    }
    setMessage({ tone: "success", text: "Saved. The change is in the audit log." });
    router.refresh();
  }

  const box = (label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string) => (
    <label className="mb-2 flex min-h-11 items-start gap-2 text-sm text-ink-800">
      <input type="checkbox" className="mt-1 h-5 w-5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint ? <span className="block text-xs text-ink-500">{hint}</span> : null}
      </span>
    </label>
  );
  const field = (label: string, value: string | number, onChange: (v: string) => void, hint?: string) => (
    <label className="mb-3 block text-sm font-medium text-ink-800">
      {label}
      <input className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint ? <span className="block text-xs font-normal text-ink-500">{hint}</span> : null}
    </label>
  );

  return (
    <div className="space-y-4">
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <Card className="p-4">
        <h2 className="mb-3 text-base font-semibold">Validity and grace</h2>
        {field("Registration validity (months)", m.periodMonths, (v) => setM({ ...m, periodMonths: num(v, m.periodMonths) }))}
        {field("Grace period (days)", m.graceDays, (v) => setM({ ...m, graceDays: num(v, m.graceDays) }), "The shop keeps working with a red banner; after this it is hidden from customers.")}
        {field("Expiring soon from (days before expiry)", m.reminderDays, (v) => setM({ ...m, reminderDays: num(v, m.reminderDays) }))}
        {box("Online renewal (Renew Now) open", m.renewalCheckoutEnabled, (v) => setM({ ...m, renewalCheckoutEnabled: v }))}
        {field("Renew Now opens (days before expiry)", m.renewalWindowDays, (v) => setM({ ...m, renewalWindowDays: num(v, m.renewalWindowDays) }))}
      </Card>
      <Card className="p-4">
        <h2 className="mb-3 text-base font-semibold">Reminders</h2>
        {box("Send reminders", m.remindersEnabled, (v) => setM({ ...m, remindersEnabled: v }), "E-mail + mobile app push + in-app alert, English and Marathi, with a Pay Now link.")}
        {field("Daily run hour (IST, 0–23)", s.reminderHourIst, (v) => setS({ ...s, reminderHourIst: num(v, s.reminderHourIst) }))}
        {field("Unpaid shops: days after registration", s.unpaidText, (v) => setS({ ...s, unpaidText: v }), "e.g. 1, 3, 7")}
        {field("Unpaid shops: then every (days, 0 = stop)", s.unpaidRepeatEveryDays, (v) => setS({ ...s, unpaidRepeatEveryDays: num(v, s.unpaidRepeatEveryDays) }))}
        {field("Expiry reminders: days before expiry (0 = expiry day)", s.expiryText, (v) => setS({ ...s, expiryText: v }), "e.g. 30, 15, 7, 6, 5, 4, 3, 2, 1, 0")}
        {box("Every day during the grace period", s.graceDaily, (v) => setS({ ...s, graceDaily: v }))}
        {box("Create a payment link for the reminder when none is active", s.autoCreateLink, (v) => setS({ ...s, autoCreateLink: v }))}
        {field("CC e-mails for the daily expiry digest", s.ccText, (v) => setS({ ...s, ccText: v }), "Comma-separated (default ceo@agtci.com).")}
      </Card>
      <Card className="p-4">
        <h2 className="mb-3 text-base font-semibold">Payment links and fees</h2>
        {field("Payment link valid for (days)", s.paymentLinkValidityDays, (v) => setS({ ...s, paymentLinkValidityDays: num(v, s.paymentLinkValidityDays) }))}
        <p className="mb-2 text-sm text-ink-700">
          Renewal fee per shop type (₹, before GST). Empty = the same as the shop&apos;s own registration fee. A shop&apos;s own renewal fee (row → Settings) overrides this.
        </p>
        {feeRuleSummary ? <p className="mb-2 break-words text-xs text-ink-500">Registration fee rule now: {feeRuleSummary}</p> : null}
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          {shopTypes.map((t) => (
            <label key={t.key} className="mb-2 block text-sm text-ink-800">
              {t.label}
              <input className={inputClass} inputMode="decimal" value={s.fees[t.key] ?? ""} onChange={(e) => setS({ ...s, fees: { ...s.fees, [t.key]: e.target.value } })} />
            </label>
          ))}
        </div>
        {box("Pay dealer / franchise commission on renewals", s.payCommissionOnRenewals, (v) => setS({ ...s, payCommissionOnRenewals: v }), "Registration commission is unchanged. Default: No.")}
      </Card>
      <Button disabled={busy} onClick={save}>
        Save settings
      </Button>
    </div>
  );
}
