"use client";

import { useState } from "react";
import clsx from "clsx";

import { Icon } from "@/components/board/icons";

export type FeatureFlagKey =
  | "dealer_programme_enabled"
  | "gov_verification_auto_approval_enabled"
  | "dealer_rating_bonus_enabled"
  | "paid_support_services_enabled"
  | "shop_onboarding_wizard_enabled";

interface FlagValue {
  enabled: boolean;
  districtCodes: string[] | null;
}

export interface FeatureFlagRow extends FlagValue {
  key: FeatureFlagKey;
  label: string;
  hint: string;
}

export interface FeatureFlagChangeRow {
  flagKey: FeatureFlagKey;
  oldValue: FlagValue;
  newValue: FlagValue;
  reason: string;
  changedByEmail: string | null;
  changedByRole: string | null;
  /** ISO time. */
  changedAt: string;
}

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

function describe(value: FlagValue, names: Map<string, string>): string {
  if (!value.enabled) return "Off";
  if (value.districtCodes === null) return "On — all of India";
  return `On — ${value.districtCodes.map((c) => names.get(c) ?? c).join(", ")}`;
}

/**
 * Admin → Feature flags (docs/dealer-programme, step 1): one card per flag in
 * the Tile Board look — the switch, every district or chosen districts, and the
 * reason the change is made. The server re-checks the admin role on every save.
 */
export function FeatureFlagsPanel({
  flags,
  changes,
  labels,
  districts,
}: {
  flags: FeatureFlagRow[];
  changes: FeatureFlagChangeRow[];
  labels: Record<FeatureFlagKey, string>;
  districts: { code: string; name: string }[];
}) {
  const names = new Map(districts.map((d) => [d.code, d.name]));
  const [saved, setSaved] = useState<Record<string, FlagValue>>(
    Object.fromEntries(flags.map((f) => [f.key, { enabled: f.enabled, districtCodes: f.districtCodes }])),
  );
  const [drafts, setDrafts] = useState(saved);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [log, setLog] = useState(changes);
  const [busy, setBusy] = useState<FeatureFlagKey | null>(null);
  const [message, setMessage] = useState<{ key: FeatureFlagKey; tone: "ok" | "error"; text: string } | null>(null);

  function update(key: FeatureFlagKey, value: Partial<FlagValue>) {
    setDrafts((current) => ({ ...current, [key]: { ...current[key], ...value } }));
  }

  async function save(key: FeatureFlagKey) {
    setBusy(key);
    setMessage(null);
    try {
      const draft = drafts[key];
      const res = await fetch("/api/admin/feature-flags", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, enabled: draft.enabled, districtCodes: draft.districtCodes, reason: reasons[key] ?? "" }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not save the flag.");
      const value = { enabled: payload.flag.enabled, districtCodes: payload.flag.districtCodes };
      setSaved((current) => ({ ...current, [key]: value }));
      setDrafts((current) => ({ ...current, [key]: value }));
      setReasons((current) => ({ ...current, [key]: "" }));
      if (payload.changed && payload.lastChange) setLog((current) => [payload.lastChange as FeatureFlagChangeRow, ...current]);
      setMessage({ key, tone: "ok", text: payload.changed ? `Saved: ${describe(value, names)}.` : "Nothing changed." });
    } catch (error) {
      setMessage({ key, tone: "error", text: error instanceof Error ? error.message : "Could not save the flag." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-3" data-testid="feature-flags">
      {flags.map((flag) => {
        const draft = drafts[flag.key];
        const current = saved[flag.key];
        const dirty = JSON.stringify(draft) !== JSON.stringify(current);
        const chosen = new Set(draft.districtCodes ?? []);
        return (
          <section
            key={flag.key}
            className={clsx(
              "rounded-2xl border-2 border-[var(--gk-line)] border-l-4 bg-white p-4",
              current.enabled ? "border-l-green-700" : "border-l-ink-400",
            )}
            data-testid={`feature-flag-${flag.key}`}
          >
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-100 text-blue-800">
                <Icon name="toggle-right" size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-bold text-ink-900">{flag.label}</h2>
                <p className="mt-0.5 text-sm text-ink-700">{flag.hint}</p>
                <p className="mt-0.5 font-mono text-xs text-ink-600">{flag.key}</p>
                <p className="mt-1 text-sm font-semibold text-ink-900" data-testid="feature-flag-value">
                  Now: {describe(current, names)}
                </p>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-[var(--gk-chip)] px-3 py-2">
              <span className="text-sm font-semibold text-ink-900" id={`${flag.key}-label`}>
                {draft.enabled ? "On" : "Off"}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={draft.enabled}
                aria-labelledby={`${flag.key}-label`}
                disabled={busy !== null}
                onClick={() => update(flag.key, { enabled: !draft.enabled })}
                className={clsx(
                  "relative inline-flex h-11 w-[4.5rem] shrink-0 items-center rounded-full border-2 transition-colors disabled:opacity-60",
                  draft.enabled ? "border-green-700 bg-green-700" : "border-ink-400 bg-ink-400",
                )}
                data-testid="feature-flag-toggle"
              >
                <span className="sr-only">{draft.enabled ? "Switch off" : "Switch on"}</span>
                <span
                  className={clsx(
                    "inline-block h-8 w-8 rounded-full bg-white shadow transition-transform",
                    draft.enabled ? "translate-x-[2.1rem]" : "translate-x-1",
                  )}
                />
              </button>
            </div>

            {draft.enabled ? (
              <fieldset className="mt-3">
                <legend className="text-sm font-semibold text-ink-900">Where</legend>
                <div className="mt-1 flex flex-wrap gap-3 text-sm">
                  <label className="inline-flex min-h-11 items-center gap-2">
                    <input
                      type="radio"
                      name={`${flag.key}-scope`}
                      checked={draft.districtCodes === null}
                      onChange={() => update(flag.key, { districtCodes: null })}
                    />
                    All of India
                  </label>
                  <label className="inline-flex min-h-11 items-center gap-2">
                    <input
                      type="radio"
                      name={`${flag.key}-scope`}
                      checked={draft.districtCodes !== null}
                      onChange={() => update(flag.key, { districtCodes: draft.districtCodes ?? [] })}
                    />
                    Chosen states / districts only
                  </label>
                </div>
                {draft.districtCodes !== null ? (
                  <div className="mt-2 grid max-h-56 grid-cols-2 gap-x-3 overflow-y-auto rounded-xl border border-[var(--gk-line)] p-2 sm:grid-cols-3" data-testid="feature-flag-districts">
                    {districts.map((d) => (
                      <label key={d.code} className="inline-flex min-h-11 items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={chosen.has(d.code)}
                          onChange={(e) => {
                            const next = new Set(chosen);
                            if (e.target.checked) next.add(d.code);
                            else next.delete(d.code);
                            update(flag.key, { districtCodes: [...next].sort() });
                          }}
                        />
                        {d.name}
                      </label>
                    ))}
                  </div>
                ) : null}
              </fieldset>
            ) : null}

            {dirty ? (
              <div className="mt-3">
                <label className="block text-sm font-semibold text-ink-900" htmlFor={`${flag.key}-reason`}>
                  Reason for the change
                </label>
                <textarea
                  id={`${flag.key}-reason`}
                  rows={2}
                  maxLength={500}
                  value={reasons[flag.key] ?? ""}
                  onChange={(e) => setReasons((r) => ({ ...r, [flag.key]: e.target.value }))}
                  className="mt-1 w-full rounded-xl border-2 border-[var(--gk-line)] p-2 text-sm"
                  data-testid="feature-flag-reason"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => save(flag.key)}
                    className="min-h-11 rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white disabled:opacity-60"
                    data-testid="feature-flag-save"
                  >
                    {busy === flag.key ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => setDrafts((d) => ({ ...d, [flag.key]: current }))}
                    className="min-h-11 rounded-xl border-2 border-[var(--gk-line)] px-4 text-sm font-semibold text-ink-900"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {message?.key === flag.key ? (
              <p role="status" className={clsx("mt-2 text-sm font-semibold", message.tone === "ok" ? "text-green-800" : "text-red-700")}>
                {message.text}
              </p>
            ) : null}
          </section>
        );
      })}

      <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
        <h2 className="text-base font-bold text-ink-900">Change log</h2>
        {log.length === 0 ? (
          <p className="mt-1 text-sm text-ink-700">No changes yet. Every flag starts off.</p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--gk-line)] text-sm" data-testid="feature-flag-log">
            {log.slice(0, 30).map((c, i) => (
              <li key={`${c.changedAt}-${i}`} className="py-2">
                <span className="font-semibold text-ink-900">{labels[c.flagKey] ?? c.flagKey}</span>
                <span className="block text-ink-700">
                  {describe(c.oldValue, names)} → {describe(c.newValue, names)} by {c.changedByEmail ?? "an admin"} on {when(c.changedAt)} IST
                </span>
                <span className="block text-ink-600">Reason: {c.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
