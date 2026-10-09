"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card } from "@/components/ui";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface OpeningHour {
  day: number;
  open: string;
  close: string;
  closed?: boolean;
}

/**
 * Shop owner "shop time" editor (§9). Lets an owner set opening/closing time
 * per weekday, or mark a day closed — the same shape the storefront already
 * reads via `isShopOpenNow`.
 */
export function ShopSettingsForm({
  shopId,
  initialHours,
}: {
  shopId: string;
  initialHours: OpeningHour[];
}) {
  const router = useRouter();
  const [hours, setHours] = useState<OpeningHour[]>(() => {
    const byDay = new Map(initialHours.map((h) => [h.day, h]));
    return Array.from({ length: 7 }, (_, day) =>
      byDay.get(day) ?? { day, open: "06:00", close: "22:00", closed: false },
    );
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function update(day: number, patch: Partial<OpeningHour>) {
    setHours((prev) =>
      prev.map((h) => (h.day === day ? { ...h, ...patch } : h)),
    );
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const response = await fetch(`/api/shops/${shopId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openingHours: hours }),
    });
    setBusy(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not save shop time.");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <Card className="p-4">
      <h2 className="mb-1 text-lg font-semibold text-ink-900">Shop time</h2>
      <p className="mb-3 text-sm text-ink-500">
        Set your opening and closing time for each day, or mark a day closed.
      </p>

      <div className="space-y-2">
        {hours.map((h) => (
          <div
            key={h.day}
            className="flex flex-wrap items-center gap-2 border-b border-cream-100 py-2 last:border-0"
          >
            <span className="w-10 text-sm font-medium text-ink-700">
              {DAY_NAMES[h.day]}
            </span>
            <input
              type="time"
              value={h.open}
              disabled={h.closed}
              onChange={(e) => update(h.day, { open: e.target.value })}
              className="rounded-lg border border-cream-200 px-2 py-1 text-sm disabled:opacity-50"
              aria-label={`${DAY_NAMES[h.day]} opening time`}
            />
            <span className="text-ink-500">–</span>
            <input
              type="time"
              value={h.close}
              disabled={h.closed}
              onChange={(e) => update(h.day, { close: e.target.value })}
              className="rounded-lg border border-cream-200 px-2 py-1 text-sm disabled:opacity-50"
              aria-label={`${DAY_NAMES[h.day]} closing time`}
            />
            <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-600">
              <input
                type="checkbox"
                checked={Boolean(h.closed)}
                onChange={(e) => update(h.day, { closed: e.target.checked })}
              />
              Closed
            </label>
          </div>
        ))}
      </div>

      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-3">
        <Button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save shop time"}
        </Button>
        {saved ? <span className="text-xs text-leaf-700">Saved.</span> : null}
      </div>
    </Card>
  );
}
