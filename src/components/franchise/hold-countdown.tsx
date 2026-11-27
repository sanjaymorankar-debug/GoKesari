"use client";

import { useEffect, useState } from "react";

/**
 * docs/flows-v3/wave4.md F21 (flag flow_f21): the time left on a zone hold, counting down every second. At zero it
 * says the hold has ended (the server releases the slot; this is display only).
 */
export function HoldCountdown({ until }: { until: string }) {
  const end = new Date(until).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((end - now) / 1000));
  if (left === 0)
    return (
      <span className="font-semibold text-red-700" data-testid="hold-countdown" suppressHydrationWarning>
        hold ended
      </span>
    );
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  return (
    <span className="font-semibold text-kesari-800" data-testid="hold-countdown" suppressHydrationWarning>
      {mm}:{ss} left
    </span>
  );
}
