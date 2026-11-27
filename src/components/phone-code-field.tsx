"use client";

/**
 * docs/flows-v3/wave5.md (F18; flag flow_f18): linking or changing a mobile asks for an SMS code sent to the new
 * number. The server answers PHONE_CODE_REQUIRED; the form then sends the code (POST /api/me/phone/code), shows
 * this field, and submits again with the code. With the flag off the server never asks, and nothing here shows.
 */
import { Field, inputClass } from "@/components/ui";

/** Did the server ask for the SMS code of the new number? */
export function phoneCodeRequired(payload: unknown): boolean {
  const details = (payload as { error?: { details?: { reason?: string } } } | null)?.error?.details;
  return details?.reason === "PHONE_CODE_REQUIRED";
}

/** Sends the code; answers where it went (masked) or throws with the server's message. */
export async function sendPhoneLinkCode(mobile: string): Promise<string> {
  const res = await fetch("/api/me/phone/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mobile }) });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error?.message ?? "Could not send the code.");
  return String(payload?.sentTo ?? "");
}

export function PhoneCodeField({ sentTo, value, onChange }: { sentTo: string; value: string; onChange: (value: string) => void }) {
  return (
    <Field label="Code sent by SMS" hint={`We sent a code to ${sentTo}. Enter it to confirm the number.`}>
      <input
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 8))}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="Code sent by SMS"
        data-testid="phone-link-code"
      />
    </Field>
  );
}
