"use client";

import { useEffect } from "react";

/** Opens the browser's print dialog once the page has rendered (Chrome kiosk-printing makes it silent). */
export function PrintNow({ auto = true, logUrl }: { auto?: boolean; logUrl?: string }) {
  useEffect(() => {
    if (logUrl) void fetch(logUrl, { cache: "no-store" }).catch(() => undefined);
    if (!auto) return;
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [auto, logUrl]);
  return (
    <div className="no-print mb-3 flex gap-2">
      <button type="button" onClick={() => window.print()} className="min-h-11 rounded-xl bg-kesari-700 px-4 text-sm font-extrabold text-white">
        Print
      </button>
      <button type="button" onClick={() => window.close()} className="min-h-11 rounded-xl border-2 border-[var(--gk-line)] px-4 text-sm font-extrabold">
        Close
      </button>
    </div>
  );
}
