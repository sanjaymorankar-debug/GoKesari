"use client";

/**
 * Consultant appointments (docs/consult-booking-2026-11): small pieces shared
 * by the customer, consultant, admin and operator screens.
 */
import clsx from "clsx";
import type { ReactNode } from "react";

import { CONSULT_MODE_LABELS, CONSULT_STATUS_LABELS, CONSULT_STATUS_TONES, type ConsultBookingStatus, type ConsultMode } from "@/lib/consult/constants";
import { formatPaiseCompact } from "@/lib/money";

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "Content-Type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    cache: "no-store",
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
    const first = fields ? Object.values(fields)[0] : null;
    throw new Error(first || payload?.error?.message || "Something went wrong. Please try again.");
  }
  return payload as T;
}

/** A price: ₹0 reads "Free". */
export const rupees = (paise: number | null | undefined) => (paise == null ? "—" : paise === 0 ? "Free" : formatPaiseCompact(paise));
/** An amount paid, due or refunded: ₹0 stays ₹0. */
export const amount = (paise: number | null | undefined) => (paise == null ? "—" : formatPaiseCompact(paise));

export function modeLabel(mode: string): string {
  return CONSULT_MODE_LABELS[mode as ConsultMode]?.en ?? mode;
}

export const MODE_ICON: Record<string, string> = { IN_PERSON: "🏢", VIDEO: "🎥", PHONE: "📞", HOME_VISIT: "🏠" };

export function StatusPill({ status, rescheduled = false }: { status: string; rescheduled?: boolean }) {
  const key = (status === "CONFIRMED" && rescheduled ? "RESCHEDULED" : status) as ConsultBookingStatus | "RESCHEDULED";
  const tone = CONSULT_STATUS_TONES[key] ?? CONSULT_STATUS_TONES.CONFIRMED;
  return (
    <span className={clsx("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-bold", tone.bg, tone.border, tone.text)} data-testid="consult-status">
      {CONSULT_STATUS_LABELS[key]?.en ?? status}
    </span>
  );
}

export function Tile({ label, value, hint, tone = "kesari" }: { label: string; value: ReactNode; hint?: string; tone?: "kesari" | "teal" | "green" | "amber" | "ink" }) {
  const tones = {
    kesari: "border-kesari-200 bg-kesari-50",
    teal: "border-teal-200 bg-teal-50",
    green: "border-leaf-300 bg-leaf-50",
    amber: "border-amber-200 bg-amber-50",
    ink: "border-[var(--gk-line)] bg-white",
  } as const;
  return (
    <div className={clsx("rounded-2xl border-2 p-3", tones[tone])}>
      <p className="text-xs font-bold uppercase tracking-wide text-ink-600">{label}</p>
      <p className="mt-0.5 text-xl font-extrabold tabular-nums text-ink-900">{value}</p>
      {hint ? <p className="text-xs text-ink-600">{hint}</p> : null}
    </div>
  );
}

export function Chip({ active, onClick, children, testId }: { active?: boolean; onClick?: () => void; children: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={clsx(
        "min-h-10 rounded-full border-2 px-3 py-1 text-sm font-bold transition-colors",
        active ? "border-kesari-600 bg-kesari-600 text-white" : "border-[var(--gk-line)] bg-white text-ink-800 hover:border-kesari-400",
      )}
    >
      {children}
    </button>
  );
}

export function Stars({ value, count }: { value: number; count: number }) {
  if (!count) return <span className="text-xs text-ink-500">New</span>;
  return (
    <span className="text-sm font-bold text-amber-700" title={`${value.toFixed(1)} from ${count} ratings`}>
      ★ {value.toFixed(1)} <span className="font-normal text-ink-500">({count})</span>
    </span>
  );
}

export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-extrabold text-ink-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Google Maps without an API key (embed of one pin) — no Maps JS load. */
export function PinMap({ latitude, longitude, label }: { latitude: number; longitude: number; label: string }) {
  return (
    <iframe
      title={`Map: ${label}`}
      className="h-56 w-full rounded-xl border-2 border-[var(--gk-line)]"
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
      src={`https://maps.google.com/maps?q=${latitude},${longitude}&z=15&output=embed`}
    />
  );
}
