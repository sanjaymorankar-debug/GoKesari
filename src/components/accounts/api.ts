"use client";

/**
 * Client calls to the Inventory & Accounting API (/api/shops/{shopId}/accounts/…).
 * Errors come back as thrown ApiError with the server's safe message.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function accountsApi<T = unknown>(shopId: string, path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const response = await fetch(`/api/shops/${shopId}/accounts/${path.replace(/^\//, "")}`, {
    method: init.method ?? (init.body !== undefined || init.form ? "POST" : "GET"),
    headers: init.form ? undefined : init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    cache: "no-store",
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const err = (data as { error?: { message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(response.status, err?.message ?? "Something went wrong. Please try again.", err?.details);
  }
  return data as T;
}

/** Upload with progress (slow mobile networks): XHR, because fetch has no upload progress. */
export function uploadWithProgress<T>(url: string, form: FormData, onProgress: (percent: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => reject(new ApiError(0, "The upload did not go through. Check your internet and try again."));
    xhr.ontimeout = () => reject(new ApiError(0, "The upload took too long. Try again on a better connection."));
    xhr.timeout = 5 * 60_000;
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, (data as { error?: { message?: string } } | null)?.error?.message ?? "Upload failed."));
    };
    xhr.send(form);
  });
}

/** ₹1,234.50 from paise. */
export function rupees(paise: number | null | undefined): string {
  if (paise == null) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100);
}

/** "12.5" from milli. */
export function qty(milli: number | null | undefined): string {
  if (milli == null) return "";
  const v = milli / 1000;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
