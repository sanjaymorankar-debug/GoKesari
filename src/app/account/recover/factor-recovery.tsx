"use client";

/**
 * Recovering an account after losing the mobile OR the e-mail (docs/flows-v3/wave5.md, F18; flag flow_f18).
 * Posts to /api/account/recover/factor: code to the working contact → (shop owners) GSTIN or PAN → new contact →
 * its code → done (signed out everywhere; sign in again).
 */
import Link from "next/link";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

type Lost = "MOBILE" | "EMAIL";
type Step = "choose" | "code" | "new" | "newCode" | "done";

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/account/recover/factor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(payload?.error?.message ?? "That did not work. Please try again.") as Error & { details?: Record<string, unknown> };
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

export function FactorRecovery() {
  const [lost, setLost] = useState<Lost | null>(null);
  const [step, setStep] = useState<Step>("choose");
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [taxId, setTaxId] = useState("");
  const [needsTaxId, setNeedsTaxId] = useState(false);
  const [token, setToken] = useState("");
  const [value, setValue] = useState("");
  const [newCode, setNewCode] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (caught) {
      const details = (caught as { details?: Record<string, unknown> }).details;
      if (details?.needsTaxId) setNeedsTaxId(true);
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  if (step === "done") {
    return (
      <Alert tone="success" title="Done">
        Your {lost === "MOBILE" ? "new mobile number" : "new e-mail"} is saved and your account was signed out on every device.{" "}
        <Link href="/signin" className="underline">
          Sign in again
        </Link>
        .
      </Alert>
    );
  }

  return (
    <Card className="p-5" data-testid="factor-recovery">
      {step === "choose" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant={lost === "MOBILE" ? "primary" : "secondary"} onClick={() => setLost("MOBILE")}>
              I lost my mobile number
            </Button>
            <Button type="button" variant={lost === "EMAIL" ? "primary" : "secondary"} onClick={() => setLost("EMAIL")}>
              I lost my e-mail
            </Button>
          </div>
          {lost ? (
            <>
              <Field label={lost === "MOBILE" ? "The e-mail of your account" : "The verified mobile number of your account"}>
                <input
                  className={inputClass}
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  type={lost === "MOBILE" ? "email" : "tel"}
                  autoComplete={lost === "MOBILE" ? "email" : "tel-national"}
                />
              </Field>
              <Button
                type="button"
                disabled={busy || contact.trim().length < 3}
                onClick={() =>
                  run(async () => {
                    const r = await post({ action: "start", lost, contact });
                    setSentTo(r.sentTo);
                    setStep("code");
                  })
                }
              >
                {busy ? "Sending…" : "Send me a code"}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {step === "code" ? (
        <div className="space-y-4">
          <p className="text-sm">If this matches an account, we sent a code to {sentTo}.</p>
          <Field label="Code">
            <input className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} />
          </Field>
          {needsTaxId ? (
            <Field label="GSTIN or PAN of your shop">
              <input className={inputClass} value={taxId} onChange={(e) => setTaxId(e.target.value)} autoCapitalize="characters" maxLength={20} />
            </Field>
          ) : null}
          <Button
            type="button"
            disabled={busy || !code.trim()}
            onClick={() =>
              run(async () => {
                const r = await post({ action: "verify", lost, contact, code, taxId: taxId || null });
                setToken(r.token);
                setStep("new");
              })
            }
          >
            {busy ? "Checking…" : "Continue"}
          </Button>
        </div>
      ) : null}

      {step === "new" || step === "newCode" ? (
        <div className="space-y-4">
          <Field label={lost === "MOBILE" ? "Your new mobile number" : "Your new e-mail"}>
            <input
              className={inputClass}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type={lost === "MOBILE" ? "tel" : "email"}
              disabled={step === "newCode"}
            />
          </Field>
          {step === "new" ? (
            <Button
              type="button"
              disabled={busy || value.trim().length < 3}
              onClick={() =>
                run(async () => {
                  const r = await post({ action: "new-code", token, value });
                  setSentTo(r.sentTo);
                  setStep("newCode");
                })
              }
            >
              {busy ? "Sending…" : "Send a code to it"}
            </Button>
          ) : (
            <>
              <p className="text-sm">We sent a code to {sentTo}.</p>
              <Field label="Code">
                <input className={inputClass} value={newCode} onChange={(e) => setNewCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} />
              </Field>
              <Button
                type="button"
                disabled={busy || !newCode.trim()}
                onClick={() =>
                  run(async () => {
                    await post({ action: "confirm", token, value, code: newCode });
                    setStep("done");
                  })
                }
              >
                {busy ? "Saving…" : "Save and sign out everywhere"}
              </Button>
            </>
          )}
        </div>
      ) : null}

      {error ? (
        <div className="mt-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}
