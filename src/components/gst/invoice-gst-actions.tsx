"use client";

/** Module 2: e-invoice (IRN) and e-way bill for an invoice — the shop's owner and operations. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";

export function InvoiceGstActions({
  invoiceId,
  einvoice,
  einvoiceApplies,
  ewayBill,
  ewayRequired,
}: {
  invoiceId: string;
  einvoice: { status: string; irn: string | null; error: string | null } | null;
  einvoiceApplies: boolean;
  ewayBill: { status: string; ewbNo: string | null; validUpto: string | null; error: string | null } | null;
  ewayRequired: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [distance, setDistance] = useState("");
  const [vehicle, setVehicle] = useState("");

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/invoices/${invoiceId}/${path}`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? "Could not complete the request.");
    }
    router.refresh();
  }

  return (
    <div className="space-y-2 print:hidden">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {einvoice?.status === "FAILED" ? <Alert tone="warning" title="E-invoice not generated yet">{einvoice.error}</Alert> : null}
      {(einvoiceApplies || einvoice) && einvoice?.status !== "GENERATED" ? (
        <Button size="sm" disabled={busy} onClick={() => void post("einvoice")}>
          {einvoice ? "Retry e-invoice" : "Generate e-invoice (IRN)"}
        </Button>
      ) : null}
      {ewayBill?.status === "GENERATED" ? (
        <p className="text-sm text-ink-700">E-way bill {ewayBill.ewbNo}, valid until {ewayBill.validUpto ? new Date(ewayBill.validUpto).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "–"}.</p>
      ) : ewayRequired ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void post("eway-bill", { distanceKm: Number(distance), vehicleNo: vehicle || undefined });
          }}
        >
          <Field label="Distance (km)"><input className={inputClass} type="number" min={1} max={4000} value={distance} onChange={(e) => setDistance(e.target.value)} required /></Field>
          <Field label="Vehicle no. (optional)"><input className={inputClass} value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="MH12AB1234" /></Field>
          <Button type="submit" size="sm" disabled={busy}>Generate e-way bill</Button>
          {ewayBill?.status === "FAILED" ? <span className="text-xs text-red-700">{ewayBill.error}</span> : null}
        </form>
      ) : null}
    </div>
  );
}
