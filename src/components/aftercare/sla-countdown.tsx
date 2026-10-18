"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui";

/** "Acknowledge in 5 h 12 m" / "Resolve overdue by 2 d" — a live SLA timer (F6.3.3, batch-2026-10 WS-C). */
export function SlaCountdown({ label, dueAt, done }: { label: string; dueAt: string; done: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  if (done) return <Badge tone="success">{label}: met</Badge>;
  const due = new Date(dueAt).getTime();
  // Before hydration, show the deadline itself (no clock mismatch).
  if (now === null) {
    return <Badge tone="neutral">{label} by {new Date(dueAt).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Kolkata" })}</Badge>;
  }
  const diff = due - now;
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const span = days > 0 ? `${days} d ${hours} h` : hours > 0 ? `${hours} h ${minutes} m` : `${minutes} m`;
  if (diff < 0) return <Badge tone="danger">{label} overdue by {span}</Badge>;
  return <Badge tone={diff < 6 * 3_600_000 ? "warning" : "info"}>{label} in {span}</Badge>;
}
