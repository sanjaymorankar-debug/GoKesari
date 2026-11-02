"use client";

/**
 * Billing v2 (docs/billing §9): controls for the shop's GST returns, ledgers
 * and IMS. Every action is the server's; this only calls the accounts API.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";

interface Filing {
  id: string;
  returnType: string;
  period: string;
  status: string;
  arn: string | null;
  error: string | null;
  ours: Record<string, number> | null;
  portal: Record<string, number> | null;
}
interface ImsRow {
  supplierGstin: string;
  supplierName: string | null;
  docType: "INV" | "CN" | "DN";
  docNumber: string;
  docDate: string;
  total: number;
  decision: string | null;
  pushed: string | null;
}

const FIELDS = ["taxable", "igst", "cgst", "sgst", "cess"] as const;

export function GstReturnsPanel({ shopId, defaultPeriod, composition, linked, linkExpires, filings }: { shopId: string; defaultPeriod: string; composition: boolean; linked: boolean; linkExpires: string | null; filings: Filing[] }) {
  const router = useRouter();
  const api = `/api/shops/${shopId}/accounts/portal`;
  const [period, setPeriod] = useState(defaultPeriod);
  const [type, setType] = useState(composition ? "CMP08" : "GSTR1");
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [otp, setOtp] = useState<Record<string, { requestId: string; value: string }>>({});
  const [ims, setIms] = useState<ImsRow[] | null>(null);
  const [ledger, setLedger] = useState<{ cash: { entries: { date: string; description: string; amount: number }[]; igst: number; cgst: number; sgst: number } } | null>(null);

  async function call(url: string, method = "POST", body?: unknown) {
    setMessage(null);
    const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      setMessage({ tone: "danger", text: payload?.error?.message ?? "That did not work." });
      return null;
    }
    return payload?.data ?? payload;
  }

  return (
    <div className="grid gap-3">
      {!linked ? (
        <Alert tone="warning" title="GSTIN not linked to the portal">
          Link it under GST → Link GSTIN (an OTP from the portal). Until then you can prepare and download returns and file them on gst.gov.in.
        </Alert>
      ) : linkExpires ? (
        <p className="text-xs text-ink-600">Portal link valid until {new Date(linkExpires).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.</p>
      ) : null}
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <Card className="flex flex-wrap items-end gap-2 p-3">
        <label className="grid gap-1 text-sm">
          Return
          <select className={inputClass} value={type} onChange={(e) => setType(e.target.value)}>
            {(composition ? ["CMP08", "GSTR4"] : ["GSTR1", "IFF", "GSTR3B"]).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Period
          <input className={`${inputClass} w-36`} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder={type === "CMP08" ? "2026-27-Q3" : type === "GSTR4" ? "2026-27" : "YYYY-MM"} />
        </label>
        <Button onClick={async () => (await call(`${api}/filings`, "POST", { returnType: type, period })) && router.refresh()}>Prepare from books</Button>
        <Button
          variant="secondary"
          disabled={!linked}
          onClick={async () => {
            const rows = await call(`${api}/ims?period=${period.slice(0, 7)}`, "GET");
            if (rows) setIms(rows);
          }}
        >
          IMS inward invoices
        </Button>
        <Button
          variant="secondary"
          disabled={!linked}
          onClick={async () => {
            const from = `${period.slice(0, 7)}-01`;
            const [y, m] = period.slice(0, 7).split("-").map(Number);
            const to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
            const l = await call(`${api}/ledgers?from=${from}&to=${to}`, "GET");
            if (l) setLedger(l);
          }}
        >
          Cash ledger (TCS credit)
        </Button>
      </Card>

      <ul className="grid gap-2 md:grid-cols-2" data-testid="gst-filings">
        {filings.map((f) => (
          <li key={f.id}>
            <Card className="grid gap-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-bold">
                  {f.returnType} · {f.period}
                </p>
                <Badge tone={f.status === "FILED" ? "success" : f.status === "ERROR" ? "danger" : f.status === "SAVED" ? "info" : "warning"}>{f.status.toLowerCase()}</Badge>
              </div>
              {f.ours ? (
                <table className="text-xs">
                  <thead>
                    <tr>
                      <th className="text-left"> </th>
                      {FIELDS.map((k) => (
                        <th key={k} className="text-right">
                          {k}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>GoKesari</td>
                      {FIELDS.map((k) => (
                        <td key={k} className="text-right tabular-nums">
                          {(f.ours?.[k] ?? 0).toFixed(2)}
                        </td>
                      ))}
                    </tr>
                    {f.portal ? (
                      <tr>
                        <td>Portal</td>
                        {FIELDS.map((k) => (
                          <td key={k} className={`text-right tabular-nums ${Math.abs((f.portal?.[k] ?? 0) - (f.ours?.[k] ?? 0)) >= 0.01 ? "font-bold text-red-700" : ""}`}>
                            {(f.portal?.[k] ?? 0).toFixed(2)}
                          </td>
                        ))}
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              ) : null}
              {f.arn ? <p className="text-sm">ARN {f.arn}</p> : null}
              {f.error ? <p className="text-xs text-red-700">{f.error}</p> : null}
              {f.status !== "FILED" ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <a className="text-sm underline" href={`${api}/filings/${f.id}/download`}>
                    Download JSON
                  </a>
                  <Button size="sm" variant="secondary" disabled={!linked} onClick={async () => (await call(`${api}/filings/${f.id}/save`)) && router.refresh()}>
                    Save on portal
                  </Button>
                  {f.status === "SAVED" ? (
                    otp[f.id] ? (
                      <>
                        <input aria-label="OTP" className={`${inputClass} h-9 w-24`} inputMode="numeric" maxLength={6} value={otp[f.id].value} onChange={(e) => setOtp({ ...otp, [f.id]: { ...otp[f.id], value: e.target.value } })} />
                        <Button size="sm" onClick={async () => (await call(`${api}/filings/${f.id}/file`, "POST", { requestId: otp[f.id].requestId, otp: otp[f.id].value })) && router.refresh()}>
                          File with EVC
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        onClick={async () => {
                          const r = await call(`${api}/filings/${f.id}/otp`);
                          if (r) setOtp({ ...otp, [f.id]: { requestId: r.requestId, value: "" } });
                        }}
                      >
                        Get filing OTP
                      </Button>
                    )
                  ) : null}
                </div>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>

      {ledger ? (
        <Card className="p-3">
          <p className="mb-1 font-bold">Electronic cash ledger</p>
          <p className="text-sm">
            IGST {ledger.cash.igst.toFixed(2)} · CGST {ledger.cash.cgst.toFixed(2)} · SGST {ledger.cash.sgst.toFixed(2)}
          </p>
          <ul className="text-xs">
            {ledger.cash.entries.map((e, i) => (
              <li key={i}>
                {e.date} — {e.description}: ₹{e.amount.toFixed(2)}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {ims ? (
        <Card className="p-3" data-testid="ims-list">
          <p className="mb-2 font-bold">IMS — inward invoices for {period.slice(0, 7)}</p>
          <ul className="grid gap-1">
            {ims.map((d) => (
              <li key={`${d.supplierGstin}-${d.docNumber}`} className="flex flex-wrap items-center gap-2 border-b border-[var(--gk-line)] py-1 text-sm last:border-b-0">
                <span className="min-w-0 flex-1">
                  {d.supplierName ?? d.supplierGstin} · {d.docNumber} · ₹{d.total.toFixed(2)}
                </span>
                {d.decision ? <Badge tone={d.decision === "ACCEPTED" ? "success" : d.decision === "REJECTED" ? "danger" : "warning"}>{d.decision.toLowerCase()}</Badge> : null}
                {(["ACCEPTED", "PENDING", "REJECTED"] as const).map((a) => (
                  <Button
                    key={a}
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const reason = a === "REJECTED" ? window.prompt("Why is it rejected?") ?? "" : null;
                      const ok = await call(`${api}/ims`, "POST", { period: period.slice(0, 7), decisions: [{ supplierGstin: d.supplierGstin, docType: d.docType, docNumber: d.docNumber, docDate: d.docDate, total: d.total, action: a, reason }] });
                      if (ok) setIms(ims.map((x) => (x === d ? { ...x, decision: a } : x)));
                    }}
                  >
                    {a === "ACCEPTED" ? "Accept" : a === "PENDING" ? "Keep pending" : "Reject"}
                  </Button>
                ))}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
