"use client";

import { useState } from "react";
import clsx from "clsx";

import { Icon } from "@/components/board/icons";

export type ReferralValue = "MANDATORY" | "OPTIONAL";
export type ReferralKey = "referral_required_customer" | "referral_required_shop";

export interface ReferralSettingRow {
  key: ReferralKey;
  label: string;
  hint: string;
  value: ReferralValue;
}

export interface ReferralChangeRow {
  settingKey: ReferralKey;
  oldValue: ReferralValue;
  newValue: ReferralValue;
  changedByEmail: string | null;
  changedByRole: string | null;
  /** ISO time. */
  changedAt: string;
}

const LABEL: Record<ReferralValue, string> = { MANDATORY: "Mandatory", OPTIONAL: "Optional" };

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

function changeText(change: ReferralChangeRow): string {
  return `${LABEL[change.oldValue]} → ${LABEL[change.newValue]} by ${change.changedByEmail ?? "an admin"} on ${when(change.changedAt)} IST`;
}

/**
 * Admin → Referral settings (docs/nearby-referral-2026-10, feature 2): one
 * Mandatory / Optional switch per registration type, in the Tile Board look.
 * The server re-checks the admin role on every change.
 */
export function ReferralSettingsPanel({
  settings,
  changes,
}: {
  settings: ReferralSettingRow[];
  changes: ReferralChangeRow[];
}) {
  const [rows, setRows] = useState(settings);
  const [log, setLog] = useState(changes);
  const [busy, setBusy] = useState<ReferralKey | null>(null);
  const [message, setMessage] = useState<{ key: ReferralKey; tone: "ok" | "error"; text: string } | null>(null);

  async function change(key: ReferralKey, value: ReferralValue) {
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/referral-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not save the setting.");
      setRows((current) => current.map((r) => (r.key === key ? { ...r, value: payload.setting.value } : r)));
      if (payload.lastChange) {
        const last = { ...payload.lastChange, changedAt: payload.lastChange.changedAt } as ReferralChangeRow;
        if (payload.changed) setLog((current) => [last, ...current]);
      }
      setMessage({ key, tone: "ok", text: `Saved: ${LABEL[value]}. Applies to new registrations from now on.` });
    } catch (error) {
      setMessage({ key, tone: "error", text: error instanceof Error ? error.message : "Could not save the setting." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2" data-testid="referral-settings">
      {rows.map((row) => {
        const mandatory = row.value === "MANDATORY";
        const last = log.find((c) => c.settingKey === row.key);
        return (
          <section
            key={row.key}
            className="rounded-2xl border-2 border-[var(--gk-line)] border-l-4 border-l-blue-600 bg-white p-4"
            data-testid={`referral-setting-${row.key}`}
          >
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-100 text-blue-800">
                <Icon name={row.key === "referral_required_shop" ? "store" : "user-plus"} size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-bold text-ink-900">{row.label}</h2>
                <p className="mt-0.5 text-sm text-ink-700">{row.hint}</p>
                <p className="mt-0.5 font-mono text-xs text-ink-600">{row.key}</p>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-[var(--gk-chip)] px-3 py-2">
              <span className="text-sm font-semibold text-ink-900" id={`${row.key}-label`}>
                Referral code is{" "}
                <strong className={mandatory ? "text-kesari-800" : "text-green-800"} data-testid="referral-setting-value">
                  {LABEL[row.value]}
                </strong>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={mandatory}
                aria-labelledby={`${row.key}-label`}
                disabled={busy !== null}
                onClick={() => change(row.key, mandatory ? "OPTIONAL" : "MANDATORY")}
                className={clsx(
                  "relative inline-flex h-11 w-[4.5rem] shrink-0 items-center rounded-full border-2 transition-colors disabled:opacity-60",
                  mandatory ? "border-kesari-700 bg-kesari-700" : "border-ink-400 bg-ink-400",
                )}
                data-testid="referral-setting-toggle"
              >
                <span className="sr-only">{mandatory ? "Switch to Optional" : "Switch to Mandatory"}</span>
                <span
                  className={clsx(
                    "inline-block h-8 w-8 rounded-full bg-white shadow transition-transform",
                    mandatory ? "translate-x-[2.1rem]" : "translate-x-1",
                  )}
                />
              </button>
            </div>
            <div className="mt-2 flex gap-2 text-xs font-semibold" aria-hidden>
              <span className={clsx("rounded-full px-2 py-0.5", !mandatory ? "bg-green-100 text-green-800" : "bg-cream-100 text-ink-600")}>Optional</span>
              <span className={clsx("rounded-full px-2 py-0.5", mandatory ? "bg-kesari-100 text-kesari-800" : "bg-cream-100 text-ink-600")}>Mandatory</span>
            </div>

            {message?.key === row.key ? (
              <p
                role="status"
                className={clsx("mt-2 text-sm font-semibold", message.tone === "ok" ? "text-green-800" : "text-red-700")}
              >
                {message.text}
              </p>
            ) : null}

            <p className="mt-3 border-t border-[var(--gk-line)] pt-2 text-xs text-ink-700" data-testid="referral-setting-last-change">
              <Icon name="history" size={14} className="mr-1 inline align-[-2px]" />
              {last ? <>Last change: {changeText(last)}</> : "Not changed since it was set up (default: Optional)."}
            </p>
          </section>
        );
      })}

      <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4 lg:col-span-2">
        <h2 className="text-base font-bold text-ink-900">Change log</h2>
        {log.length === 0 ? (
          <p className="mt-1 text-sm text-ink-700">No changes yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--gk-line)] text-sm" data-testid="referral-setting-log">
            {log.slice(0, 20).map((c, i) => (
              <li key={`${c.changedAt}-${i}`} className="py-2">
                <span className="font-semibold text-ink-900">
                  {c.settingKey === "referral_required_shop" ? "Shop owner registration" : "Customer registration"}
                </span>
                <span className="block text-ink-700">
                  {changeText(c)}
                  {c.changedByRole ? ` (${c.changedByRole.toLowerCase()})` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
