"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button } from "@/components/ui";
import { INDIAN_MOBILE_HINT, formatIndianMobile, parseIndianMobile } from "@/lib/contact";

const inputClass =
  "min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none";

/** My Profile: the mobile number used for login and by delivery partners. */
export function PhoneLinkForm({ current }: { current: string | null }) {
  const router = useRouter();
  const [mobile, setMobile] = useState("");
  const [linked, setLinked] = useState(current);
  const [editing, setEditing] = useState(!current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(method: "PUT" | "DELETE") {
    setError(null);
    if (method === "PUT" && !parseIndianMobile(mobile).ok) return setError(INDIAN_MOBILE_HINT);
    setBusy(true);
    const res = await fetch("/api/me/phone", {
      method,
      headers: { "content-type": "application/json" },
      body: method === "PUT" ? JSON.stringify({ mobile }) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(body?.error?.message ?? "Could not update the number.");
    setLinked(method === "PUT" ? body.phoneE164 : null);
    setEditing(method === "DELETE");
    setMobile("");
    router.refresh();
  }

  return (
    <div data-testid="phone-link">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-700">
          <span className="font-medium">Mobile:</span> {linked ? formatIndianMobile(linked) : "Not added"}
        </p>
        {linked && !editing ? (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Change
            </Button>
            <Button size="sm" variant="ghost" onClick={() => save("DELETE")} disabled={busy}>
              Remove
            </Button>
          </div>
        ) : null}
      </div>
      <p className="text-xs text-ink-500">
        Needed to place orders. You can also log in with it — sign-in codes are always emailed to you.
      </p>
      {editing ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="rounded-lg border border-cream-200 bg-cream-50 px-3 py-2 text-sm text-ink-600">+91</span>
          <input
            value={mobile}
            onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))}
            inputMode="numeric"
            autoComplete="tel-national"
            placeholder="10-digit mobile number"
            aria-label="Mobile number"
            className={inputClass}
          />
          <Button onClick={() => save("PUT")} disabled={busy || !mobile}>
            {linked ? "Save" : "Add"}
          </Button>
          {linked ? (
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="mt-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </div>
  );
}
