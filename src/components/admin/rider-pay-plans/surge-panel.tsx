"use client";

import { useState } from "react";

import { Alert, Badge, Button, Card, Field, Money, inputClass } from "@/components/ui";

import { formatIstDateTime, istInputToUtcIso, multiplierToBp, rupeesToPaiseOrNull, surgeState, utcToIstInput } from "./format";
import type { SurgeReason, SurgeRow, ZoneOption } from "./types";
import { useApi } from "./use-api";

const REASONS: { key: SurgeReason; label: string }[] = [
  { key: "RAIN", label: "Rain" },
  { key: "FESTIVAL", label: "Festival" },
  { key: "EVENT", label: "Event" },
  { key: "OTHER", label: "Other" },
];
const STATE_TONE = { live: "warning", scheduled: "info", ended: "neutral" } as const;

/** Manual surges for a city or a zone: live / scheduled / ended, start one, end one now. */
export function SurgePanel({ surges, zones, nowIso }: { surges: SurgeRow[]; zones: ZoneOption[]; /** Server time of the render (no hydration drift). */ nowIso: string }) {
  const api = useApi();
  const [f, setF] = useState(() => ({
    where: "CITY" as "CITY" | "ZONE",
    city: "",
    zoneId: "",
    multiplier: "1.3",
    flat: "0",
    reason: "RAIN" as SurgeReason,
    note: "",
    start: "",
    end: utcToIstInput(new Date(new Date(nowIso).getTime() + 3 * 3_600_000)),
  }));
  const set = (key: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [key]: e.target.value });

  const multiplierBp = multiplierToBp(f.multiplier);
  const flatPaise = rupeesToPaiseOrNull(f.flat);
  const endsAt = istInputToUtcIso(f.end);
  const startsAt = f.start ? istInputToUtcIso(f.start) : null;
  const problems: string[] = [];
  if (multiplierBp == null || multiplierBp < 10000 || multiplierBp > 30000) problems.push("Multiplier must be between 1.0 and 3.0.");
  if (flatPaise == null) problems.push("Flat add-on must be an amount in rupees (0 for none).");
  if (f.where === "CITY" && !f.city.trim()) problems.push("Type the city.");
  if (f.where === "ZONE" && !f.zoneId) problems.push("Choose the zone.");
  if (!endsAt) problems.push("Set when the surge ends.");
  if (f.start && !startsAt) problems.push("The start time is not a valid date and time.");

  const zoneName = (id: string | null) => {
    const z = zones.find((x) => x.id === id);
    return z ? `${z.city} — ${z.name}` : "(removed zone)";
  };
  const cities = [...new Set(zones.map((z) => z.city))].sort();

  async function start() {
    if (problems.length) return;
    const ok = await api.call("/api/admin/rider-pay-plans/surges", "POST", {
      city: f.where === "CITY" ? f.city.trim() : null,
      zoneId: f.where === "ZONE" ? f.zoneId : null,
      multiplierBp,
      flatPaise,
      reason: f.reason,
      note: f.note.trim() || null,
      startsAt,
      endsAt,
    });
    if (ok) setF({ ...f, note: "", start: "" });
  }

  const now = new Date(nowIso);
  return (
    <section className="space-y-3" aria-labelledby="surges-heading">
      <h2 id="surges-heading" className="text-lg font-semibold text-ink-900">
        Surges
      </h2>
      <p className="text-sm text-ink-500">
        A surge raises the pay of new offers in a city or zone for a while (rain, festival, event). The highest multiplier wins
        (peak-slot surges included) and flat add-ons are added. Quotes already locked do not change.
      </p>
      <Card className="p-3">
        {surges.length === 0 ? <p className="text-sm text-ink-500">No surges yet.</p> : null}
        <ul className="divide-y divide-cream-100">
          {surges.map((s) => {
            const state = surgeState(s, now);
            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" data-testid="surge-row">
                <div>
                  <p className="font-medium text-ink-900">
                    <Badge tone={STATE_TONE[state]}>{state}</Badge> {s.zoneId ? zoneName(s.zoneId) : (s.city ?? "Everywhere")} · ×{(s.multiplierBp / 10000).toFixed(2)}
                    {s.flatPaise > 0 ? (
                      <>
                        {" "}+ <Money paise={s.flatPaise} />
                      </>
                    ) : null}{" "}
                    · {REASONS.find((r) => r.key === s.reason)?.label ?? s.reason}
                  </p>
                  <p className="text-xs text-ink-500">
                    {formatIstDateTime(s.startsAt)} → {formatIstDateTime(s.endedAt ?? s.endsAt)}
                    {s.endedAt ? " (ended early)" : ""}
                    {s.note ? ` · ${s.note}` : ""}
                  </p>
                </div>
                {state !== "ended" ? (
                  <Button size="sm" variant="danger" disabled={api.busy} onClick={() => api.call(`/api/admin/rider-pay-plans/surges/${s.id}/end`, "POST", {})}>
                    End now
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium text-ink-700">Start a surge</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Where">
            <select className={inputClass} value={f.where} onChange={set("where")}>
              <option value="CITY">A city</option>
              <option value="ZONE">A delivery zone</option>
            </select>
          </Field>
          {f.where === "CITY" ? (
            <Field label="City">
              <input className={inputClass} value={f.city} onChange={set("city")} list="surge-cities" placeholder="Pune" />
              <datalist id="surge-cities">
                {cities.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
          ) : (
            <Field label="Zone">
              <select className={inputClass} value={f.zoneId} onChange={set("zoneId")}>
                <option value="">Choose a zone…</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.city} — {z.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Reason">
            <select className={inputClass} value={f.reason} onChange={set("reason")}>
              {REASONS.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Multiplier ×" hint="1.0 to 3.0, e.g. 1.3">
            <input className={inputClass} value={f.multiplier} onChange={set("multiplier")} inputMode="decimal" />
          </Field>
          <Field label="Flat add-on ₹ per order">
            <input className={inputClass} value={f.flat} onChange={set("flat")} inputMode="decimal" />
          </Field>
          <Field label="Note shown to riders (optional)">
            <input className={inputClass} value={f.note} onChange={set("note")} maxLength={200} placeholder="Heavy rain" />
          </Field>
          <Field label="Starts (IST)" hint="Blank = now.">
            <input className={inputClass} type="datetime-local" value={f.start} onChange={set("start")} />
          </Field>
          <Field label="Ends (IST)" hint="At most 3 days after the start.">
            <input className={inputClass} type="datetime-local" value={f.end} onChange={set("end")} />
          </Field>
        </div>
        {problems.length && (f.city || f.zoneId) ? <p className="text-xs text-red-700">{problems.join(" ")}</p> : null}
        {api.error ? <Alert tone="danger">{api.error}</Alert> : null}
        <Button disabled={api.busy || problems.length > 0} onClick={start}>
          Start surge
        </Button>
      </Card>
    </section>
  );
}
