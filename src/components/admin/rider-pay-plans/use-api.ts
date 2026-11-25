"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** JSON calls to the admin API with one busy flag and a plain-words error; refreshes the page on success. */
export function useApi() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call<T = unknown>(url: string, method: string, body?: unknown, opts: { refresh?: boolean } = {}): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
        const problems = payload?.error?.details?.problems as string[] | undefined;
        setError(
          fields
            ? Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join(" ")
            : problems?.length
              ? problems.join(" ")
              : (payload?.error?.message ?? "That did not work. Try again."),
        );
        return null;
      }
      if (opts.refresh !== false) router.refresh();
      return (payload ?? {}) as T;
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, setError, call };
}
