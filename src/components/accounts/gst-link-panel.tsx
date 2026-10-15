"use client";

/**
 * "Link your GSTIN" (docs/inventory-accounting-2026-10, Part 3): consent,
 * GSTIN and GST portal username → OTP from the portal → linked. Shows the
 * link's status and lets the owner remove the access at any time. When the
 * portal API is not switched on, it says so and points to the file upload.
 */
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Alert, Badge, Button, Field, inputClass } from "@/components/ui";

import { accountsApi, ApiError } from "./api";

export interface GstLinkInfo {
  status: "OTP_SENT" | "LINKED" | "EXPIRED" | "REVOKED";
  gstin: string;
  portalUsername: string;
  provider: string;
  lastSyncAt: string | null;
  tokenExpiresAt: string | null;
  lastError: string | null;
}

const STATUS_TEXT: Record<GstLinkInfo["status"], { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  LINKED: { label: "Linked", tone: "success" },
  OTP_SENT: { label: "Waiting for OTP", tone: "warning" },
  EXPIRED: { label: "Session expired — link again", tone: "danger" },
  REVOKED: { label: "Unlinked", tone: "neutral" },
};

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export function GstLinkPanel({
  shopId,
  apiAvailable,
  providerName,
  mockOtp,
  defaultGstin,
  consentText,
  link,
}: {
  shopId: string;
  apiAvailable: boolean;
  providerName: string | null;
  /** Only for the sandbox ("mock") provider. */
  mockOtp: string | null;
  defaultGstin: string;
  consentText: string;
  link: GstLinkInfo | null;
}) {
  const router = useRouter();
  const ids = useId();
  const [consent, setConsent] = useState(false);
  const [gstin, setGstin] = useState(link?.gstin ?? defaultGstin);
  const [username, setUsername] = useState(link?.portalUsername ?? "");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const [restart, setRestart] = useState(false);

  if (!apiAvailable) {
    return (
      <div className="space-y-2 text-sm text-ink-700">
        <p>
          Linking through the GST portal is <strong>not switched on</strong> for GoKesari yet (it needs a GST Suvidha Provider contract).
        </p>
        <p>
          You can still use everything here: download your GSTR-2B (or 2A / 1) from gst.gov.in and{" "}
          <a href="#gst-import" className="font-semibold text-kesari-700 underline">
            upload it below
          </a>
          .
        </p>
      </div>
    );
  }

  const mode: "form" | "otp" | "linked" = restart ? "form" : otpSent || link?.status === "OTP_SENT" ? "otp" : link?.status === "LINKED" ? "linked" : "form";

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await action());
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const requestOtp = () =>
    run(async () => {
      await accountsApi(shopId, "gst/link", { method: "POST", body: { gstin, username, consent } });
      setOtpSent(true);
      setRestart(false);
      setOtp("");
      return "OTP sent by the GST portal to the mobile number and email registered for your GSTIN.";
    });

  const verify = () =>
    run(async () => {
      await accountsApi(shopId, "gst/verify", { method: "POST", body: { otp } });
      setOtpSent(false);
      setOtp("");
      return "Your GSTIN is linked. You can now pull GSTR-2B from the portal.";
    });

  const unlink = () => {
    if (!window.confirm("Remove GoKesari's access to your GST returns data?")) return;
    void run(async () => {
      await accountsApi(shopId, "gst/link", { method: "DELETE" });
      setOtpSent(false);
      setRestart(false);
      return "Unlinked. GoKesari can no longer read your GST returns data.";
    });
  };

  return (
    <div className="space-y-3 text-sm">
      {link ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ink-700">
          <dt className="font-medium">Status</dt>
          <dd>
            <Badge tone={STATUS_TEXT[link.status].tone}>{STATUS_TEXT[link.status].label}</Badge>
          </dd>
          <dt className="font-medium">GSTIN</dt>
          <dd className="font-mono">{link.gstin}</dd>
          <dt className="font-medium">Last pulled</dt>
          <dd>{when(link.lastSyncAt)}</dd>
          {link.status === "LINKED" && link.tokenExpiresAt ? (
            <>
              <dt className="font-medium">Session until</dt>
              <dd>{when(link.tokenExpiresAt)}</dd>
            </>
          ) : null}
          {link.lastError ? (
            <>
              <dt className="font-medium">Last error</dt>
              <dd className="text-red-700">{link.lastError}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {mode === "form" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void requestOtp();
          }}
        >
          <label className="flex items-start gap-2 rounded-xl border border-[var(--gk-line)] bg-violet-50 p-3">
            <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-violet-700" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
            <span className="text-ink-800">{consentText}</span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="GSTIN">
              <input className={`${inputClass} min-h-11 font-mono uppercase`} value={gstin} onChange={(e) => setGstin(e.target.value)} maxLength={15} autoComplete="off" required />
            </Field>
            <Field label="GST portal username" hint="The username you use on gst.gov.in">
              <input className={`${inputClass} min-h-11`} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !consent || !gstin.trim() || !username.trim()}>
              {busy ? "Sending…" : "Send OTP"}
            </Button>
            {restart ? (
              <Button variant="ghost" onClick={() => setRestart(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      {mode === "otp" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <Field label="OTP from the GST portal" hint={mockOtp ? `Sandbox (mock provider): the OTP is ${mockOtp}.` : "Sent to the mobile number and email registered for your GSTIN."}>
            <input
              id={`${ids}-otp`}
              className={`${inputClass} min-h-11 max-w-48 font-mono tracking-widest`}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              required
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || otp.length < 4}>
              {busy ? "Checking…" : "Verify OTP"}
            </Button>
            <Button variant="ghost" onClick={() => setRestart(true)}>
              Send a new OTP
            </Button>
          </div>
        </form>
      ) : null}

      {mode === "linked" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={unlink} disabled={busy}>
            Unlink GSTIN
          </Button>
          <Button variant="ghost" onClick={() => setRestart(true)}>
            Link again
          </Button>
        </div>
      ) : null}

      {providerName ? <p className="text-xs text-ink-600">Provider: {providerName}</p> : null}

      <div aria-live="polite" className="space-y-2">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {message ? <Alert tone="success">{message}</Alert> : null}
      </div>
    </div>
  );
}
