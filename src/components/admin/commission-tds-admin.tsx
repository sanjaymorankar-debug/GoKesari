"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

interface Rate {
  id: string;
  payeeType: string;
  panStatus: string;
  rateBp: number;
  thresholdPaise: number;
  mode: string;
  section: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  confirmedByCa: boolean;
  confirmedAt: string | null;
  note: string | null;
}
interface Certificate {
  id: string;
  payeeLabel: string;
  certificateNumber: string;
  rateBp: number;
  validFrom: string;
  validTo: string;
  limitPaise: number | null;
  status: string;
}
interface Challan {
  id: string;
  periodMonth: string;
  section: string;
  amountPaise: number;
  bsrCode: string;
  challanSerial: string;
  depositedOn: string;
}
interface Exceptions {
  flagged: { batchId: string; month: string | null; flag: string | null; overridden: boolean; overrideReason: string | null; grossPaise: number; tdsPaise: number; status: string }[];
  heldWithoutPan: { dealerId: string; memberId: string | null; amountPaise: number }[];
}

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const pct = (bp: number) => `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
const FLAG: Record<string, string> = { UNCONFIRMED_RATE: "TDS row not confirmed by the CA", NO_RATE: "No TDS row applies", REVERSAL_PRIOR_FY: "Reversal of an earlier financial year" };

/**
 * Admin → TDS on commission (gap report Part D): dated rows with the CA's
 * confirmation, lower / nil certificates, challans, the monthly and 26Q
 * downloads, Form 16A uploads and the exceptions. The CA confirms rows; an
 * admin overrides a blocked payout with a reason. The server checks every step.
 */
export function CommissionTdsAdmin({ role, tdsOn, rates, certificates, challans, exceptions }: { role: string; tdsOn: boolean; rates: Rate[]; certificates: Certificate[]; challans: Challan[]; exceptions: Exceptions }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rate, setRate] = useState({ payeeType: "ANY", panStatus: "PAN_OK", rate: "2", threshold: "20000", mode: "CATCH_UP", section: "", from: "" });
  const [cert, setCert] = useState({ panHash: "", payeeLabel: "", certificateNumber: "", rate: "0", validFrom: "", validTo: "", limit: "" });
  const [challan, setChallan] = useState({ periodMonth: "", section: "", amount: "", bsrCode: "", challanSerial: "", depositedOn: "" });
  const [period, setPeriod] = useState({ month: new Date().toISOString().slice(0, 7), fy: "2026-27", quarter: "3" });
  const [form16a, setForm16a] = useState({ panHash: "", payeeLabel: "", certificateNumber: "", file: null as File | null });

  async function post(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/commission-tds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setNotice(done);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function upload16a() {
    if (!form16a.file) return;
    const buffer = new Uint8Array(await form16a.file.arrayBuffer());
    let binary = "";
    for (const b of buffer) binary += String.fromCharCode(b);
    await post(
      { action: "uploadForm16a", panHash: form16a.panHash, payeeLabel: form16a.payeeLabel, financialYear: period.fy, quarter: Number(period.quarter), certificateNumber: form16a.certificateNumber, fileName: form16a.file.name, base64: btoa(binary) },
      "Form 16A uploaded: the payee sees it on their dealer page.",
    );
  }

  return (
    <div className="space-y-4" data-testid="commission-tds-admin">
      {error ? <Alert tone="danger" title="Could not do that">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Alert tone={tdsOn ? "info" : "warning"}>
        Rule dealerPayoutTds is {tdsOn ? "on: payouts deduct TDS by the rows below" : "off: no TDS is deducted (switch it on in Admin → Settings once the CA has confirmed the rows)"}. A payout taxed under a row the CA has not confirmed
        cannot be approved or paid unless an admin overrides it with a reason.
      </Alert>

      <Card className="space-y-3 p-4">
        <h2 className="text-base font-bold">TDS rows (dated)</h2>
        <ul className="divide-y divide-cream-200 text-sm" data-testid="tds-rows">
          {rates.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-semibold">
                  {r.payeeType} · {r.panStatus === "PAN_OK" ? "with PAN" : "no PAN"}
                </span>{" "}
                · {pct(r.rateBp)} above {rs(r.thresholdPaise)} a year · {r.mode === "CATCH_UP" ? "catch-up" : "excess only"} · {r.section} · from {r.effectiveFrom}
                {r.effectiveTo ? ` to ${r.effectiveTo}` : ""}{" "}
                {r.confirmedByCa ? <Badge tone="success">CA-confirmed</Badge> : <Badge tone="warning">not confirmed</Badge>}
              </span>
              {!r.effectiveTo ? (
                <span className="flex gap-2">
                  {role === "CA" && !r.confirmedByCa ? (
                    <Button size="sm" disabled={busy} onClick={() => post({ action: "confirmRate", id: r.id, confirmed: true }, "Row confirmed.")}>
                      Confirm (CA)
                    </Button>
                  ) : null}
                  {r.confirmedByCa ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => post({ action: "confirmRate", id: r.id, confirmed: false }, "Confirmation withdrawn.")}>
                      Withdraw confirmation
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="grid gap-2 sm:grid-cols-4">
          <Field label="Payee type">
            <select className={inputClass} value={rate.payeeType} onChange={(e) => setRate({ ...rate, payeeType: e.target.value })}>
              {["ANY", "INDIVIDUAL", "FIRM", "COMPANY"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label="PAN status">
            <select className={inputClass} value={rate.panStatus} onChange={(e) => setRate({ ...rate, panStatus: e.target.value })}>
              <option value="PAN_OK">With PAN</option>
              <option value="NO_PAN">No PAN</option>
            </select>
          </Field>
          <Field label="Rate %">
            <input className={inputClass} value={rate.rate} onChange={(e) => setRate({ ...rate, rate: e.target.value })} />
          </Field>
          <Field label="Annual threshold (₹)">
            <input className={inputClass} value={rate.threshold} onChange={(e) => setRate({ ...rate, threshold: e.target.value })} />
          </Field>
          <Field label="Mode">
            <select className={inputClass} value={rate.mode} onChange={(e) => setRate({ ...rate, mode: e.target.value })}>
              <option value="CATCH_UP">Catch-up (whole year once past the threshold)</option>
              <option value="EXCESS_ONLY">Excess only</option>
            </select>
          </Field>
          <Field label="Section (free text)">
            <input className={inputClass} value={rate.section} onChange={(e) => setRate({ ...rate, section: e.target.value })} />
          </Field>
          <Field label="Effective from">
            <input type="date" className={inputClass} value={rate.from} onChange={(e) => setRate({ ...rate, from: e.target.value })} />
          </Field>
          <div className="flex items-end">
            <Button
              disabled={busy || !rate.section || !rate.from}
              onClick={() =>
                post(
                  { action: "addRate", payeeType: rate.payeeType, panStatus: rate.panStatus, rateBp: Math.round(Number(rate.rate) * 100), thresholdPaise: Math.round(Number(rate.threshold) * 100), mode: rate.mode, section: rate.section, effectiveFrom: rate.from },
                  "New row added; the previous one is closed. The CA confirms it.",
                )
              }
            >
              Add row
            </Button>
          </div>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-base font-bold">Lower / nil deduction certificates</h2>
        <ul className="divide-y divide-cream-200 text-sm" data-testid="tds-certificates">
          {certificates.map((c) => (
            <li key={c.id} className="flex flex-wrap justify-between gap-2 py-2">
              <span>
                {c.payeeLabel} · {c.certificateNumber} · {pct(c.rateBp)} · {c.validFrom} to {c.validTo}
                {c.limitPaise != null ? ` · up to ${rs(c.limitPaise)}` : ""} <Badge tone={c.status === "ACTIVE" ? "success" : "neutral"}>{c.status.toLowerCase()}</Badge>
              </span>
              {c.status === "ACTIVE" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt("Why is it withdrawn?");
                    if (reason) post({ action: "withdrawCertificate", id: c.id, reason }, "Certificate withdrawn.");
                  }}
                >
                  Withdraw
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="grid gap-2 sm:grid-cols-4">
          <Field label="Payee PAN key" hint="From the payee's row in the team mapping (never the PAN itself).">
            <input className={inputClass} value={cert.panHash} onChange={(e) => setCert({ ...cert, panHash: e.target.value })} />
          </Field>
          <Field label="Payee">
            <input className={inputClass} value={cert.payeeLabel} onChange={(e) => setCert({ ...cert, payeeLabel: e.target.value })} />
          </Field>
          <Field label="Certificate number">
            <input className={inputClass} value={cert.certificateNumber} onChange={(e) => setCert({ ...cert, certificateNumber: e.target.value })} />
          </Field>
          <Field label="Rate %">
            <input className={inputClass} value={cert.rate} onChange={(e) => setCert({ ...cert, rate: e.target.value })} />
          </Field>
          <Field label="Valid from">
            <input type="date" className={inputClass} value={cert.validFrom} onChange={(e) => setCert({ ...cert, validFrom: e.target.value })} />
          </Field>
          <Field label="Valid to">
            <input type="date" className={inputClass} value={cert.validTo} onChange={(e) => setCert({ ...cert, validTo: e.target.value })} />
          </Field>
          <Field label="Limit (₹, optional)">
            <input className={inputClass} value={cert.limit} onChange={(e) => setCert({ ...cert, limit: e.target.value })} />
          </Field>
          <div className="flex items-end">
            <Button
              disabled={busy || !cert.panHash || !cert.certificateNumber}
              onClick={() =>
                post(
                  { action: "addCertificate", panHash: cert.panHash, payeeLabel: cert.payeeLabel, certificateNumber: cert.certificateNumber, rateBp: Math.round(Number(cert.rate) * 100), validFrom: cert.validFrom, validTo: cert.validTo, limitPaise: cert.limit ? Math.round(Number(cert.limit) * 100) : null },
                  "Certificate recorded.",
                )
              }
            >
              Add certificate
            </Button>
          </div>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-base font-bold">Challans, 26Q and Form 16A</h2>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Month">
            <input type="month" className={inputClass} value={period.month} onChange={(e) => setPeriod({ ...period, month: e.target.value })} />
          </Field>
          <a className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 px-3 text-sm font-medium" href={`/api/admin/commission-tds?view=deductions&month=${period.month}&format=csv`}>
            Monthly TDS per payee (CSV)
          </a>
          <Field label="Financial year">
            <input className={inputClass} value={period.fy} onChange={(e) => setPeriod({ ...period, fy: e.target.value })} />
          </Field>
          <Field label="Quarter">
            <select className={inputClass} value={period.quarter} onChange={(e) => setPeriod({ ...period, quarter: e.target.value })}>
              {["1", "2", "3", "4"].map((q) => (
                <option key={q}>{q}</option>
              ))}
            </select>
          </Field>
          <a className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 px-3 text-sm font-medium" href={`/api/admin/commission-tds?view=26q&fy=${period.fy}&quarter=${period.quarter}&format=csv`}>
            26Q data (CSV, full PANs — logged)
          </a>
        </div>
        <ul className="text-sm" data-testid="tds-challans">
          {challans.map((c) => (
            <li key={c.id}>
              {c.periodMonth} · {c.section} · {rs(c.amountPaise)} · BSR {c.bsrCode} · challan {c.challanSerial} · {c.depositedOn}
            </li>
          ))}
        </ul>
        <div className="grid gap-2 sm:grid-cols-6">
          <input aria-label="Challan month" placeholder="YYYY-MM" className={inputClass} value={challan.periodMonth} onChange={(e) => setChallan({ ...challan, periodMonth: e.target.value })} />
          <input aria-label="Challan section" placeholder="Section" className={inputClass} value={challan.section} onChange={(e) => setChallan({ ...challan, section: e.target.value })} />
          <input aria-label="Challan amount" placeholder="Amount ₹" className={inputClass} value={challan.amount} onChange={(e) => setChallan({ ...challan, amount: e.target.value })} />
          <input aria-label="BSR code" placeholder="BSR code" className={inputClass} value={challan.bsrCode} onChange={(e) => setChallan({ ...challan, bsrCode: e.target.value })} />
          <input aria-label="Challan serial" placeholder="Challan serial" className={inputClass} value={challan.challanSerial} onChange={(e) => setChallan({ ...challan, challanSerial: e.target.value })} />
          <input aria-label="Deposited on" type="date" className={inputClass} value={challan.depositedOn} onChange={(e) => setChallan({ ...challan, depositedOn: e.target.value })} />
        </div>
        <Button
          variant="secondary"
          disabled={busy || !challan.bsrCode}
          onClick={() => post({ action: "addChallan", periodMonth: challan.periodMonth, section: challan.section, amountPaise: Math.round(Number(challan.amount) * 100), bsrCode: challan.bsrCode, challanSerial: challan.challanSerial, depositedOn: challan.depositedOn }, "Challan recorded.")}
        >
          Record challan
        </Button>
        <div className="grid gap-2 border-t border-cream-200 pt-3 sm:grid-cols-4">
          <input aria-label="Form 16A payee PAN key" placeholder="Payee PAN key" className={inputClass} value={form16a.panHash} onChange={(e) => setForm16a({ ...form16a, panHash: e.target.value })} />
          <input aria-label="Form 16A payee" placeholder="Payee" className={inputClass} value={form16a.payeeLabel} onChange={(e) => setForm16a({ ...form16a, payeeLabel: e.target.value })} />
          <input aria-label="Form 16A certificate number" placeholder="Certificate number" className={inputClass} value={form16a.certificateNumber} onChange={(e) => setForm16a({ ...form16a, certificateNumber: e.target.value })} />
          <input aria-label="Form 16A PDF" type="file" accept="application/pdf" className={inputClass} onChange={(e) => setForm16a({ ...form16a, file: e.target.files?.[0] ?? null })} />
        </div>
        <Button variant="secondary" disabled={busy || !form16a.file || !form16a.panHash} onClick={upload16a}>
          Upload Form 16A for {period.fy} Q{period.quarter}
        </Button>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold">Exceptions</h2>
        <ul className="divide-y divide-cream-200 text-sm" data-testid="tds-exceptions">
          {exceptions.flagged.map((f) => (
            <li key={f.batchId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {f.month} · {FLAG[f.flag ?? ""] ?? f.flag} · gross {rs(f.grossPaise)}, TDS {rs(f.tdsPaise)} · {f.status.toLowerCase()}
                {f.overridden ? ` · overridden: ${f.overrideReason}` : ""}
              </span>
              {role === "ADMIN" && !f.overridden && (f.flag === "UNCONFIRMED_RATE" || f.flag === "NO_RATE") ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt("Why pay it before the CA confirms? (kept on the payout)");
                    if (reason) post({ action: "overrideBlock", batchId: f.batchId, reason }, "Override recorded: the payout can be paid.");
                  }}
                >
                  Override (admin)
                </Button>
              ) : null}
            </li>
          ))}
          {exceptions.heldWithoutPan.map((h) => (
            <li key={`${h.dealerId}-${h.memberId}`} className="py-2">
              Held without a PAN: {rs(h.amountPaise)} ({h.memberId ? "team member" : "dealer"})
            </li>
          ))}
          {exceptions.flagged.length + exceptions.heldWithoutPan.length === 0 ? <li className="py-2 text-ink-500">None.</li> : null}
        </ul>
      </Card>
    </div>
  );
}
