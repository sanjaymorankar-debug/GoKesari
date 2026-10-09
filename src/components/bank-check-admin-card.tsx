"use client";

/**
 * Finance: the Cashfree bank account check (O-7) — whether it is switched on,
 * which environment variables the server found, and a connection test with
 * Cashfree's own sandbox sample account. The test shows Cashfree's answer and
 * this server's outbound IP, to whitelist in Cashfree when no public key is set.
 */
import { useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";

export interface BankCheckAdminInfo {
  enabled: boolean;
  configured: boolean;
  env: "sandbox" | "production" | null;
  foundAs: { clientId: string; clientSecret: string } | null;
  twoFactor: "SIGNATURE" | "IP_WHITELIST" | null;
  expectedNames: string[];
  recent: { result: string; statusCode: string | null; httpStatus: number | null; errorMessage: string | null; nameMatchResult: string | null; verified: boolean; createdAt: string }[];
}

interface TestResult {
  configured: boolean;
  env: string | null;
  outboundIp: string | null;
  outcome: {
    result: "VALID" | "INVALID" | "ERROR";
    httpStatus: number | null;
    statusCode: string | null;
    nameAtBank: string | null;
    bankName: string | null;
    nameMatchResult: string | null;
    errorMessage: string | null;
  } | null;
}

const RESULT_TONE = { VALID: "success", INVALID: "danger", ERROR: "warning", NOT_CONFIGURED: "neutral" } as const;

export function BankCheckAdminCard({ status, canManage }: { status: BankCheckAdminInfo; canManage: boolean }) {
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runTest() {
    setBusy(true);
    setError(null);
    setTest(null);
    try {
      const response = await fetch("/api/admin/bank-account-check/test", { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "The connection test failed.");
      setTest(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The connection test failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid="bank-check-admin">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-ink-900">Bank check with Cashfree (no ₹1 payment)</h2>
        <div className="flex gap-2">
          <Badge tone={status.enabled ? "success" : "neutral"}>{status.enabled ? "Rule on" : "Rule off"}</Badge>
          <Badge tone={status.configured ? "success" : "warning"}>{status.configured ? `Keys found (${status.env})` : "Keys not found"}</Badge>
        </div>
      </div>
      {status.configured && status.foundAs ? (
        <p className="text-xs text-ink-600" data-testid="bank-check-found-as">
          Read from <span className="font-mono">{status.foundAs.clientId}</span> and <span className="font-mono">{status.foundAs.clientSecret}</span>. Two-factor:{" "}
          {status.twoFactor === "SIGNATURE" ? "signature with the public key" : "IP whitelist in Cashfree (no public key set)"}.
        </p>
      ) : (
        <p className="text-xs text-ink-600">
          The server looks for: <span className="font-mono">{status.expectedNames.join(", ")}</span>. Set one client ID / secret pair in the hosting environment and
          rebuild.
        </p>
      )}
      {!status.enabled ? <p className="text-xs text-ink-600">Switch the rule “bankAccountCheck” on in Business rules to check bank accounts when they are saved.</p> : null}

      {canManage ? (
        <div className="space-y-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void runTest()}>
            {busy ? "Testing…" : "Test connection (sandbox sample account)"}
          </Button>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {test ? (
            <div className="rounded-lg bg-cream-50 px-3 py-2 text-xs text-ink-700" data-testid="bank-check-test-result">
              {!test.configured ? (
                <p>Keys not found — nothing was sent to Cashfree.</p>
              ) : test.outcome ? (
                <p>
                  Cashfree answered: <strong>{test.outcome.result}</strong>
                  {test.outcome.httpStatus ? ` (HTTP ${test.outcome.httpStatus})` : ""}
                  {test.outcome.statusCode ? ` · ${test.outcome.statusCode}` : ""}
                  {test.outcome.nameAtBank ? ` · name at bank ${test.outcome.nameAtBank}` : ""}
                  {test.outcome.nameMatchResult ? ` · ${test.outcome.nameMatchResult}` : ""}
                  {test.outcome.bankName ? ` · ${test.outcome.bankName}` : ""}
                  {test.outcome.errorMessage ? ` · ${test.outcome.errorMessage}` : ""}
                </p>
              ) : null}
              <p className="mt-1">
                This server’s outbound IP: <span className="font-mono">{test.outboundIp ?? "unknown"}</span>
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {status.recent.length > 0 ? (
        <div>
          <p className="text-xs font-medium uppercase text-ink-500">Latest checks</p>
          <ul className="mt-1 space-y-1 text-xs text-ink-700">
            {status.recent.map((r, i) => (
              <li key={`${r.createdAt}-${i}`} className="flex flex-wrap items-center gap-2">
                <Badge tone={RESULT_TONE[r.result as keyof typeof RESULT_TONE] ?? "neutral"}>{r.result}</Badge>
                <span>{new Date(r.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}</span>
                {r.statusCode ? <span className="font-mono">{r.statusCode}</span> : null}
                {r.nameMatchResult ? <span>{r.nameMatchResult}</span> : null}
                {r.verified ? <span className="text-leaf-700">verified</span> : null}
                {r.errorMessage ? <span className="text-amber-800">{r.errorMessage}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
