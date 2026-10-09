"use client";

import { useEffect, useState } from "react";

/** A ticking IST clock — on the rider ID card it shows the screen is live, not a screenshot. */
export function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) return null;
  return (
    <span className="font-mono" data-testid="live-clock">
      {now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" })}
    </span>
  );
}
