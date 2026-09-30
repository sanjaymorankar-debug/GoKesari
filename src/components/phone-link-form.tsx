"use client";

import { useState } from "react";

import { COUNTRY_CODES } from "@/lib/phone";

/** Profile control: link the mobile number this account can log in with. */
export function PhoneLinkForm({ current }: { current: string | null }) {
  const [countryCode, setCountryCode] = useState("+91");
  const [mobile, setMobile] = useState("");
  const [linked, setLinked] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(method: "PUT" | "DELETE") {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/me/phone", {
      method,
      headers: { "content-type": "application/json" },
      body: method === "PUT" ? JSON.stringify({ countryCode, mobile }) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body?.error?.message ?? "Could not update the number.");
      return;
    }
    setLinked(method === "PUT" ? body.phoneE164 : null);
    setMobile("");
  }

  return (
    <div>
      <p className="text-sm font-medium text-ink-700">Mobile number for login</p>
      <p className="text-xs text-ink-500">
        {linked ? `Linked: ${linked}. ` : "Not linked. "}
        Sign-in codes are emailed to the address on this account.
      </p>
      <div className="mt-2 flex gap-2">
        <select
          value={countryCode}
          onChange={(e) => setCountryCode(e.target.value)}
          className="rounded-lg border border-cream-200 px-2 py-2 text-sm"
          aria-label="Country code"
        >
          {COUNTRY_CODES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
          inputMode="numeric"
          placeholder="Mobile number"
          aria-label="Mobile number"
          className="min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-sm"
        />
        <button
          type="button"
          disabled={busy || !mobile}
          onClick={() => save("PUT")}
          className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {linked ? "Change" : "Link"}
        </button>
        {linked ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => save("DELETE")}
            className="rounded-lg border border-cream-200 px-3 py-2 text-sm"
          >
            Remove
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
