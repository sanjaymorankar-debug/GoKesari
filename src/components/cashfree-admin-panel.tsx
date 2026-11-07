"use client";

/**
 * Admin → Payments → Cashfree (docs/payments-cashfree-audit-2026-11): the
 * site's Cashfree set-up, Cashfree's eligible payment methods, and the ₹1
 * payment test — opened in Cashfree's own checkout (the admin chooses card,
 * UPI, wallet or net banking there), then checked with Cashfree and refunded.
 * Times are shown in IST.
 */
import { useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";
import { openCashfreeCheckout } from "@/lib/cashfree-checkout";
import type { CashfreeHealthReport, LiveTestResult } from "@/server/payments/cashfree-health";

interface TestRow {
  action: string;
  entityId: string | null;
  newValue: unknown;
  createdAt: string;
}

const IST = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "medium" });
const ist = (value: string | null | undefined) => (value ? `${IST.format(new Date(value))} IST` : "—");

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (HTTP ${response.status}).`);
  return body as T;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-cream-100 py-1.5 text-sm sm:grid-cols-[14rem_1fr]">
      <dt className="text-ink-500">{label}</dt>
      <dd className="break-words text-ink-900">{children}</dd>
    </div>
  );
}

export function CashfreeAdminPanel({
  initialHealth,
  initialTests,
  canManage,
  returnedOrderId,
}: {
  initialHealth: CashfreeHealthReport;
  initialTests: TestRow[];
  canManage: boolean;
  returnedOrderId: string | null;
}) {
  const [health, setHealth] = useState(initialHealth);
  const [tests, setTests] = useState(initialTests);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LiveTestResult | null>(null);
  const [pendingOrder, setPendingOrder] = useState<string | null>(returnedOrderId);

  async function refresh(live: boolean) {
    setBusy(live ? "live" : "refresh");
    setError(null);
    try {
      const data = await call<{ health: CashfreeHealthReport; tests: TestRow[] }>(`/api/admin/payments/cashfree${live ? "?live=1" : ""}`);
      setHealth(data.health);
      setTests(data.tests);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function finish(orderId: string, refund: "full" | "partial" = "full") {
    setBusy("finish");
    setError(null);
    try {
      const done = await call<LiveTestResult>(`/api/admin/payments/cashfree/test/${encodeURIComponent(orderId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refund }),
      });
      setResult(done);
      // A partial-refund test stays open until the rest is refunded.
      setPendingOrder(done.paid && done.remainingPaise === 0 ? null : orderId);
      await refresh(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function startTest(partial = false) {
    setBusy("start");
    setError(null);
    setResult(null);
    let orderId: string | null = null;
    try {
      const started = await call<{ orderId: string; paymentSessionId: string; mode: "sandbox" | "production" }>("/api/admin/payments/cashfree/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountPaise: partial ? 200 : 100 }),
      });
      orderId = started.orderId;
      setPendingOrder(started.orderId);
      await openCashfreeCheckout({ paymentSessionId: started.paymentSessionId, orderId: started.orderId }, started.mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
    // Whatever the checkout said, Cashfree's own record decides (and refunds a paid test).
    if (orderId) await finish(orderId, partial ? "partial" : "full");
  }

  const tone = (ok: boolean) => (ok ? "success" : "danger");

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {health.problems.length > 0 ? (
        <Alert tone="danger" title="Needs attention">
          <ul className="list-disc pl-5">
            {health.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      ) : (
        <Alert tone="success">No set-up problems found on this site.</Alert>
      )}

      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-ink-900">This site</h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => void refresh(false)} disabled={busy != null}>
              Refresh
            </Button>
            <Button size="sm" onClick={() => void refresh(true)} disabled={busy != null || !health.pg.configured}>
              {busy === "live" ? "Asking Cashfree…" : "Ask Cashfree (keys + payment methods)"}
            </Button>
          </div>
        </div>
        <dl>
          <Row label="Site">
            {health.site.host ?? "—"} <Badge tone={health.site.kind === "production" ? "info" : "neutral"}>{health.site.kind}</Badge>
          </Row>
          <Row label="Public URL">{health.site.publicBaseUrl}</Row>
          <Row label="Payments (PG)">
            <Badge tone={tone(health.pg.configured)}>{health.pg.configured ? "keys set" : "no keys"}</Badge> {health.pg.env} · {health.pg.apiBase} · API {health.pg.apiVersion} · keys look{" "}
            {health.pg.keyKind}
          </Row>
          <Row label="Order payments gateway">{health.pg.orderGateway} (PAYMENT_GATEWAY)</Row>
          <Row label="Webhook secret">{health.pg.webhookSecret}</Row>
          <Row label="Refund speed">{health.pg.refundSpeed}</Row>
          <Row label="Top-up / fee webhook">{health.urls.topUpAndRegistrationWebhook ?? "not sent (site is not https)"}</Row>
          <Row label="Order webhook">{health.urls.orderWebhook}</Row>
          <Row label="Payouts">
            <Badge tone={health.payouts.problem ? "danger" : health.payouts.configured ? "success" : "neutral"}>{health.payouts.configured ? "keys set" : "no keys"}</Badge> {health.payouts.env} · rule provider{" "}
            {health.payouts.provider}
            {health.payouts.problem ? ` — ${health.payouts.problem}` : ""}
          </Row>
          <Row label="Secure ID (bank check)">
            <Badge tone={health.verification.problem ? "danger" : health.verification.configured ? "success" : "neutral"}>{health.verification.configured ? "keys set" : "no keys"}</Badge>{" "}
            {health.verification.env} · 2FA {health.verification.twoFactor ?? "—"}
            {health.verification.problem ? ` — ${health.verification.problem}` : ""}
          </Row>
          <Row label="Rules">
            online order payment {health.rules.onlinePaymentsEnabled ? "on" : "off"} ({health.rules.onlinePaymentMethods.join(", ")}) · shop wallet {health.rules.shopWalletEnabled ? "on" : "off"} · self-registration{" "}
            {health.rules.selfRegistrationEnabled ? "on" : "off"}
          </Row>
          <Row label="Checked">{ist(health.checkedAt)}</Row>
        </dl>
        {health.live ? (
          <div className="space-y-2 pt-2">
            <p className="text-sm">
              Keys:{" "}
              <Badge tone={health.live.keysAccepted ? "success" : health.live.keysAccepted === false ? "danger" : "warning"}>
                {health.live.keysAccepted ? "accepted" : health.live.keysAccepted === false ? "refused" : "unknown"}
              </Badge>{" "}
              (HTTP {health.live.keysHttpStatus ?? "—"}){health.live.apiVersionDeprecatedAt ? ` · API version deprecated at ${health.live.apiVersionDeprecatedAt}` : ""}
            </p>
            {health.live.eligibility.error ? <Alert tone="warning">Eligible payment methods: {health.live.eligibility.error}</Alert> : null}
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              {health.live.eligibility.methods.map((m) => (
                <li key={m.method} className="rounded border border-cream-200 px-2 py-1">
                  <Badge tone={m.eligible ? "success" : "neutral"}>{m.eligible ? "on" : "off"}</Badge> <b>{m.method}</b>
                  {m.options.length ? <span className="text-ink-500"> — {m.options.slice(0, 8).join(", ")}{m.options.length > 8 ? " …" : ""}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-semibold text-ink-900">Only the Cashfree dashboard can confirm</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
          {health.dashboardChecks.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-base font-semibold text-ink-900">₹1 payment test</h2>
        <p className="text-sm text-ink-700">
          Opens Cashfree&apos;s checkout for ₹1. Pay with the method you want to test (credit card, debit card, UPI, a wallet or net banking). GoKesari then reads the
          result from Cashfree and refunds the ₹1 at once. On the test site use only Cashfree&apos;s sandbox test cards / UPI IDs; on gokesari.com it is a real ₹1 that
          comes back.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void startTest()} disabled={!canManage || busy != null || !health.pg.configured || health.problems.some((p) => p.startsWith("Payments:"))}>
            {busy === "start" ? "Opening checkout…" : "Start ₹1 test"}
          </Button>
          <Button variant="secondary" onClick={() => void startTest(true)} disabled={!canManage || busy != null || !health.pg.configured || health.problems.some((p) => p.startsWith("Payments:"))}>
            ₹2 test, partial refund (₹1 back, then ₹1)
          </Button>
          {pendingOrder ? (
            <Button variant="secondary" onClick={() => void finish(pendingOrder)} disabled={!canManage || busy != null}>
              {busy === "finish" ? "Checking…" : `Check & refund ${pendingOrder}`}
            </Button>
          ) : null}
        </div>
        {result ? (
          <div className="space-y-1 rounded border border-cream-200 p-3 text-sm">
            <p>
              <b>{result.orderId}</b> ({result.env}) — order {result.orderStatus} <Badge tone={result.paid ? "success" : "warning"}>{result.paid ? "paid" : "not paid"}</Badge>
            </p>
            {result.attempts.map((a) => (
              <p key={a.cfPaymentId}>
                cf_payment_id {a.cfPaymentId} · {a.status} · {a.group ?? "—"} · {a.instrument ?? "—"} · {ist(a.time)}
                {a.message ? ` · ${a.message}` : ""}
              </p>
            ))}
            {result.refunds.map((r) => (
              <p key={r.refundId}>
                Refund {r.refundId} · cf_refund_id {r.cfRefundId ?? "—"} · ₹{((r.amountPaise ?? 0) / 100).toFixed(2)} · {r.status} · {r.speed ?? "STANDARD"} · {ist(r.createdAt)}
              </p>
            ))}
            {result.paid && result.remainingPaise > 0 ? <p>Not refunded yet: ₹{(result.remainingPaise / 100).toFixed(2)} — press “Check &amp; refund” to send it back.</p> : null}
          </div>
        ) : null}
        {tests.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-cream-100 uppercase text-ink-500">
                <tr>
                  <th className="px-2 py-1">When (IST)</th>
                  <th className="px-2 py-1">Order</th>
                  <th className="px-2 py-1">What</th>
                </tr>
              </thead>
              <tbody>
                {tests.map((t) => {
                  const v = (t.newValue ?? {}) as Partial<LiveTestResult> & { env?: string };
                  const paidAttempt = v.attempts?.find((a) => a.status === "SUCCESS");
                  return (
                    <tr key={`${t.action}-${t.entityId}-${t.createdAt}`} className="border-b border-cream-100">
                      <td className="px-2 py-1">{ist(t.createdAt)}</td>
                      <td className="px-2 py-1">{t.entityId}</td>
                      <td className="px-2 py-1">
                        {t.action.endsWith("started")
                          ? `started (${v.env ?? ""})`
                          : `${v.paid ? "paid" : "not paid"}${paidAttempt ? ` · ${paidAttempt.group ?? ""} · cf_payment_id ${paidAttempt.cfPaymentId}` : ""}${v.refund ? ` · refund ${v.refund.cfRefundId ?? v.refund.refundId} ${v.refund.status}` : ""}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
