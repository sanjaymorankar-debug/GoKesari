/** docs/dual-auth-2026-11: small JSON helper for the DualVerify components (uses the unwrapped fetch). */
export interface ApiFailure {
  ok: false;
  status: number;
  message: string;
  details: Record<string, unknown> | null;
}

type RawFetch = typeof fetch;

/** The page's original fetch, kept by the guard before it wraps window.fetch (no loop on our own calls). */
export function rawFetch(): RawFetch {
  const w = window as unknown as { __gkRawFetch?: RawFetch };
  return w.__gkRawFetch ?? window.fetch.bind(window);
}

export async function postJson<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | ApiFailure> {
  try {
    const res = await rawFetch()(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string; details?: Record<string, unknown> } } | T | null;
    if (!res.ok) {
      const err = (json as { error?: { message?: string; details?: Record<string, unknown> } } | null)?.error;
      const fields = err?.details?.fields as Record<string, string> | undefined;
      const message = fields && Object.values(fields).length ? Object.values(fields).join(" ") : (err?.message ?? "Something went wrong. Please try again.");
      return { ok: false, status: res.status, message, details: err?.details ?? null };
    }
    const data = json && typeof json === "object" && "data" in (json as object) ? (json as { data: T }).data : (json as T);
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0, message: "No connection. Check your internet and try again.", details: null };
  }
}
