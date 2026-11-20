"use client";

/** GoKesari Health admin (docs/health/): small pieces shared by the admin tabs. */
import type { ReactNode } from "react";

import { Badge } from "@/components/ui";

export const ADMIN_API = "/api/admin/health";

/** Sends a POST action; returns the JSON answer, or null after showing the error. */
export type Post = <T = Record<string, unknown>>(body: Record<string, unknown>, done: string | ((result: T) => string)) => Promise<T | null>;

export function toCsv(columns: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Saves text as a file in the browser (CSV reports, sample files). */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text.startsWith("﻿") || !type.startsWith("text/csv") ? text : `﻿${text}`], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function VerificationBadge({ value }: { value: string }) {
  return <Badge tone={value === "VERIFIED" ? "success" : value === "REJECTED" || value === "FAILED" ? "danger" : value === "PENDING" || value === "SUBMITTED" ? "info" : value === "MISSING" ? "warning" : "neutral"}>{value.replace(/_/g, " ").toLowerCase()}</Badge>;
}

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <span className="text-ink-600">{label}:</span>
      <span className="font-semibold text-ink-900">{children}</span>
    </div>
  );
}

export function Loading({ what = "Loading…" }: { what?: string }) {
  return <p className="text-sm text-ink-600">{what}</p>;
}

export function Nothing({ children = "Nothing here." }: { children?: ReactNode }) {
  return <p className="rounded-2xl border-2 border-dashed border-[var(--gk-line)] bg-white p-4 text-sm text-ink-600">{children}</p>;
}

export const card = "rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3";
