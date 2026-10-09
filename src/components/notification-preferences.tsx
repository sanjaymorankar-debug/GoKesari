"use client";

import { useState } from "react";

import { Alert, Card } from "@/components/ui";

export interface PreferenceRowView {
  category: string;
  label: string;
  description: string;
  mandatory: boolean;
  channels: { channel: string; enabled: boolean; available: boolean }[];
}

const CHANNEL_LABEL: Record<string, string> = {
  IN_APP: "In-app",
  EMAIL: "Email",
  SMS: "SMS",
  PUSH: "Push",
  WHATSAPP: "WhatsApp",
};

/** Per-category, per-channel switches. Channels with no provider yet are shown as "coming soon". */
export function NotificationPreferences({ initial }: { initial: PreferenceRowView[] }) {
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(category: string, channel: string, enabled: boolean) {
    const key = `${category}:${channel}`;
    setBusy(key);
    setError(null);
    const res = await fetch("/api/notifications/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, channel, enabled }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(null);
    if (!res.ok) {
      setError(payload?.error?.message ?? "Could not save that setting.");
      return;
    }
    setRows(payload.preferences);
  }

  const channels = rows[0]?.channels.map((c) => c.channel) ?? [];

  return (
    <Card className="p-6" data-testid="notification-preferences">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-500">Notification settings</h2>
      <p className="mb-3 text-sm text-ink-500">Choose how you hear about each kind of update.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-500">
              <th className="py-1 pr-3 font-medium">Updates</th>
              {channels.map((c) => (
                <th key={c} className="px-2 py-1 text-center font-medium">
                  {CHANNEL_LABEL[c] ?? c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.category} className="border-t border-cream-100">
                <td className="py-2 pr-3">
                  <p className="font-medium text-ink-800">{row.label}</p>
                  <p className="text-xs text-ink-500">{row.description}</p>
                </td>
                {row.channels.map((c) => (
                  <td key={c.channel} className="px-2 py-2 text-center">
                    {c.available ? (
                      <input
                        type="checkbox"
                        aria-label={`${row.label} — ${CHANNEL_LABEL[c.channel] ?? c.channel}`}
                        checked={c.enabled}
                        disabled={busy === `${row.category}:${c.channel}` || (row.mandatory && (c.channel === "IN_APP" || c.channel === "EMAIL"))}
                        onChange={(e) => toggle(row.category, c.channel, e.target.checked)}
                      />
                    ) : (
                      <span className="text-xs text-ink-500">soon</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}
