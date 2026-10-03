"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { PersonalDetailsFields, type GenderValue } from "@/components/profile-setup";
import { Alert, Button, Field, inputClass } from "@/components/ui";
import { EMAIL_HINT, isValidEmail } from "@/lib/contact";

/** My Profile: name and gender. */
export function ProfileDetailsForm({ initial }: { initial: { name: string; gender: GenderValue | "" } }) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [gender, setGender] = useState<GenderValue | "">(initial.gender);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() || null, gender: gender || null, markComplete: true }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) return setStatus({ tone: "danger", text: payload?.error?.message ?? "Could not save your details." });
    setStatus({ tone: "success", text: "Saved." });
    router.refresh();
  }

  return (
    <form onSubmit={save} className="grid gap-4" data-testid="profile-details-form">
      {status ? <Alert tone={status.tone}>{status.text}</Alert> : null}
      <PersonalDetailsFields name={name} setName={setName} gender={gender} setGender={setGender} />
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save details"}
        </Button>
      </div>
    </form>
  );
}

/** My Profile: change the sign-in email. A code goes to the NEW address and must be entered before it is saved. */
export function EmailChangeForm({ current }: { current: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    setError(null);
    if (!isValidEmail(email)) return setError(EMAIL_HINT);
    setBusy(true);
    const res = await fetch("/api/profile/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) return setError(payload?.error?.message ?? "Could not send the code.");
    setSentTo(payload.maskedEmail);
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch("/api/profile/email", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) return setError(payload?.error?.message ?? "Could not confirm the code.");
    setDone(payload.email);
    setOpen(false);
    setSentTo(null);
    setCode("");
    setEmail("");
    router.refresh();
  }

  return (
    <div data-testid="email-change">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-700">
          <span className="font-medium">Email:</span> {done ?? current}
        </p>
        {!open ? (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Change email
          </Button>
        ) : null}
      </div>
      {done ? <p className="mt-1 text-xs text-leaf-700">Email updated. Use it to sign in from now on.</p> : null}
      {open ? (
        <div className="mt-3 grid gap-3 rounded-lg border border-cream-200 p-3">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {!sentTo ? (
            <form onSubmit={send} className="grid gap-2">
              <Field label="New email address" hint="We'll send a code to this address. Your email changes only after you enter it.">
                <input type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? "Sending…" : "Send code"}
                </Button>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={confirm} className="grid gap-2">
              <p className="text-sm text-ink-600">
                Enter the code we sent to <strong>{sentTo}</strong>.
              </p>
              <input
                className={`${inputClass} tracking-widest`}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                aria-label="Code"
                required
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? "Checking…" : "Confirm new email"}
                </Button>
                <Button variant="secondary" onClick={() => send()} disabled={busy}>
                  Resend code
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSentTo(null);
                    setCode("");
                  }}
                >
                  Use a different email
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
