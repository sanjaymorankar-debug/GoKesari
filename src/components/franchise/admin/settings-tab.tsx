"use client";
/**
 * Admin → Franchise → Settings (final brief §5.2, §5.3, §5.6, §9): booking, provisional sale, standard fee and band,
 * optional min / max fee, tier names (one of each pair) and colours, slots, holds, launch limits, reminders, split
 * mode, tail, month-end and the rest — saved as a new config version with a reason (audited). The commission and
 * bonus figures are on the "Commission & bonus" tab (they apply from the next month).
 */
import { useState } from "react";

import { Button, Card, inputClass } from "@/components/ui";
import { formatIst } from "@/lib/franchise";
import { TIER_NAME_CHOICES } from "@/lib/franchise-zones";

import { call, istInputToIso, type Act, type Json, type Tier } from "./shared";

type Unit = "rupees" | "rupeesOrBlank" | "percent" | "count" | "bool" | "text";
interface Field {
  key: string;
  label: string;
  unit: Unit;
  help?: string;
}

const FIELDS: Field[] = [
  { key: "bookingOpen", label: "Booking open", unit: "bool" },
  { key: "allowProvisionalSale", label: "Allow zone sale at provisional fees", unit: "bool", help: "Off: zones with a provisional fee show \"Fees being finalised\" and checkout is disabled." },
  { key: "standardFeePaise", label: "Standard annual fee (₹, before GST)", unit: "rupees" },
  { key: "standardBandBp", label: "Standard band ± (%)", unit: "percent", help: "Exactly ± this is Standard." },
  { key: "feeMinPaise", label: "Minimum fee ₹ (blank = off)", unit: "rupeesOrBlank" },
  { key: "feeMaxPaise", label: "Maximum fee ₹ (blank = off)", unit: "rupeesOrBlank" },
  { key: "gstRateBp", label: "GST on the franchise fee (%)", unit: "percent" },
  { key: "validityMonths", label: "Franchise term (months)", unit: "count" },
  { key: "maxOwnersPerZone", label: "Default maximum franchises per zone (1 or 2)", unit: "count" },
  { key: "reservationHoldMinutes", label: "Checkout slot hold (minutes)", unit: "count" },
  { key: "maxAreasPerBooking", label: "Most zones in one cart", unit: "count" },
  { key: "launchMaxOwners", label: "Launch offer: dealers", unit: "count" },
  { key: "launchMaxAreas", label: "Launch offer: zones", unit: "count" },
  { key: "launchCloseRule", label: "Launch offer closes on (first_limit_reached / owners_only / areas_only)", unit: "text" },
  { key: "renewalWindowDays", label: "Renewal opens days before expiry", unit: "count" },
  { key: "inactiveNoticeDays", label: "Inactive zone: tell owners days before expiry", unit: "count" },
  { key: "tailMode", label: "Tail mode (years_after_lapse / fixed_end_of_year_3)", unit: "text" },
  { key: "tailYears", label: "Tail years after lapse", unit: "count" },
  { key: "reminderHourIst", label: "Expiry reminders from (IST hour)", unit: "count" },
  { key: "digestHourIst", label: "CEO digest at (IST hour)", unit: "count" },
  { key: "calcHourIst", label: "Month calculation from (IST hour)", unit: "count" },
  { key: "calcLastDay", label: "Calculation runs to day", unit: "count" },
  { key: "statementDay", label: "Statements on day", unit: "count" },
  { key: "statementHourIst", label: "Statements at (IST hour)", unit: "count" },
  { key: "payoutOnNextWorkingDay", label: "Payout date skips Sundays / holidays", unit: "bool" },
  { key: "clockOffsetDays", label: "Test clock (days; refused on gokesari.com)", unit: "count" },
];

function shown(v: unknown, unit: Unit): string {
  if (unit === "bool") return v ? "true" : "false";
  if (v == null) return "";
  if (unit === "rupees" || unit === "rupeesOrBlank" || unit === "percent") return String(Number(v) / 100);
  return String(v);
}

function parsed(s: string, unit: Unit): unknown {
  if (unit === "bool") return s === "true";
  if (unit === "text") return s.trim();
  if (unit === "rupeesOrBlank" && s.trim() === "") return null;
  const n = Number(s);
  if (unit === "count") return Math.round(n);
  return Math.round(n * 100);
}

export function SettingsTab({ config, version, versions, isAdmin, act }: { config: Json; version: number; versions: { version: number; effectiveFrom: string; reason: string }[]; isAdmin: boolean; act: Act }) {
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(FIELDS.map((f) => [f.key, shown(config[f.key], f.unit)])));
  const [names, setNames] = useState<Record<Tier, string>>({ ...(config.tierNames as Record<Tier, string>) });
  const [colours, setColours] = useState<Record<Tier, string>>({ ...(config.tierColours as Record<Tier, string>) });
  const [splitMode, setSplitMode] = useState(String(config.recurringSplitMode ?? "split"));
  const [cc, setCc] = useState(((config.expiryCc as string[]) ?? []).join(", "));
  const [holidays, setHolidays] = useState(((config.bankHolidays as string[]) ?? []).join(", "));
  const [reason, setReason] = useState("");
  const [from, setFrom] = useState("");
  const save = () => {
    const patch: Json = Object.fromEntries(FIELDS.map((f) => [f.key, parsed(vals[f.key] ?? "", f.unit)]));
    patch.tierNames = names;
    patch.tierColours = colours;
    patch.recurringSplitMode = splitMode;
    patch.expiryCc = cc.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    patch.bankHolidays = holidays.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    return act(() => call("/api/admin/franchise/config", "PUT", { patch, reason, effectiveFrom: istInputToIso(from) ?? undefined }), "Saved as a new version (money settings apply from the 1st of next month)");
  };
  return (
    <Card className="space-y-3 p-4" data-testid="admin-settings">
      <h2 className="font-bold text-ink-900">Franchise settings (version {version})</h2>
      <p className="text-xs text-ink-600">Admin only. Every save is a new version with a reason, logged with who, the old and new value and the IST time. Bookings and commissions keep the version in force when they were made.</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="text-sm text-ink-700">
            {f.label}
            {f.unit === "bool" ? (
              <select className={inputClass} value={vals[f.key]} disabled={!isAdmin} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : (
              <input className={inputClass} value={vals[f.key]} readOnly={!isAdmin} inputMode={f.unit === "text" ? "text" : "decimal"} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            )}
            {f.help ? <span className="block text-xs text-ink-500">{f.help}</span> : null}
          </label>
        ))}
        <label className="text-sm text-ink-700">
          Two franchises in a zone: free-team shops&apos; recurring commission
          <select className={inputClass} value={splitMode} disabled={!isAdmin} onChange={(e) => setSplitMode(e.target.value)}>
            <option value="split">Split 50/50</option>
            <option value="nearest">To the nearest owner</option>
          </select>
        </label>
        <label className="text-sm text-ink-700">
          Expiry / notice copy to (e-mails)
          <input className={inputClass} value={cc} readOnly={!isAdmin} onChange={(e) => setCc(e.target.value)} />
        </label>
        <label className="text-sm text-ink-700">
          Bank holidays (YYYY-MM-DD, comma-separated)
          <input className={inputClass} value={holidays} readOnly={!isAdmin} onChange={(e) => setHolidays(e.target.value)} />
        </label>
      </div>
      <h3 className="font-semibold text-ink-900">Tier names and badge colours</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(TIER_NAME_CHOICES) as Tier[]).map((t) => (
          <div key={t} className="flex items-end gap-2">
            <label className="flex-1 text-sm text-ink-700">
              {t.charAt(0) + t.slice(1).toLowerCase()} tier name
              <select className={inputClass} value={names[t]} disabled={!isAdmin} onChange={(e) => setNames({ ...names, [t]: e.target.value })}>
                {TIER_NAME_CHOICES[t].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="text-sm text-ink-700">
              Colour
              <input type="color" className="block h-10 w-14 rounded border border-cream-200" value={colours[t]} disabled={!isAdmin} onChange={(e) => setColours({ ...colours, [t]: e.target.value })} />
            </label>
          </div>
        ))}
      </div>
      {isAdmin ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <input className={inputClass} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <input className={inputClass} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Effective from (IST, blank = now)" title="Effective from (IST, blank = now)" />
          <Button onClick={save} disabled={reason.trim().length < 5}>
            Save new version
          </Button>
        </div>
      ) : null}
      <h3 className="pt-2 font-semibold text-ink-900">Versions</h3>
      <ul className="text-xs text-ink-700">
        {versions.map((v) => (
          <li key={v.version}>
            v{v.version} · from {formatIst(v.effectiveFrom)} IST · {v.reason}
          </li>
        ))}
      </ul>
    </Card>
  );
}
