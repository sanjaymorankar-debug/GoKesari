"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

export interface PortalCode {
  code: string;
  shareLink: string;
  whatsapp: string;
  qrSvg: string;
}

export interface PortalEmployee {
  id: string;
  employeeId: string;
  name: string;
  mobileMasked: string | null;
  status: "ACTIVE" | "INACTIVE";
  code: string | null;
}

/**
 * The dealer's own page (docs/dealer-programme, GKS-DR-003/004): the dealer
 * code with its QR and share links, and the employees — add one with the
 * dealer's own Employee ID, see and share their code, deactivate or
 * reactivate. The full dashboard (shops, commission, rating) comes with the
 * later steps.
 */
export function DealerPortal({ legalName, code, employees }: { legalName: string; code: PortalCode | null; employees: PortalEmployee[] }) {
  const router = useRouter();
  const [people, setPeople] = useState(employees);
  const [draft, setDraft] = useState({ employeeId: "", name: "", mobile: "" });
  const [shown, setShown] = useState<{ id: string; code: PortalCode } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function call<T>(url: string, init: RequestInit, label: string): Promise<T | null> {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(url, init);
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      return payload as T;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    const res = await call<{ salesperson: PortalEmployee }>(
      "/api/dealer/salespeople",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...draft, mobile: draft.mobile.trim() || null }) },
      "add",
    );
    if (res) {
      setPeople((p) => [...p, res.salesperson]);
      setDraft({ employeeId: "", name: "", mobile: "" });
      router.refresh();
    }
  }

  async function toggle(person: PortalEmployee) {
    const status = person.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    const res = await call<{ salesperson: PortalEmployee }>(
      `/api/dealer/salespeople/${person.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) },
      `toggle-${person.id}`,
    );
    if (res) setPeople((p) => p.map((x) => (x.id === person.id ? res.salesperson : x)));
  }

  async function showCode(person: PortalEmployee) {
    if (shown?.id === person.id) return setShown(null);
    const res = await call<PortalCode>(`/api/dealer/code?salesperson=${person.id}`, {}, `qr-${person.id}`);
    if (res) setShown({ id: person.id, code: res });
  }

  return (
    <div className="space-y-4" data-testid="dealer-portal">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {code ? (
        <Card className="grid gap-4 p-4 sm:grid-cols-[auto_1fr]">
          <div className="mx-auto w-48 rounded-xl border border-cream-200 bg-white p-2 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full" aria-label={`QR code for ${code.code}`} dangerouslySetInnerHTML={{ __html: code.qrSvg }} />
          <div className="min-w-0 space-y-2">
            <p className="text-sm text-ink-500">Your dealer code</p>
            <p className="break-all font-mono text-2xl font-bold tracking-wide text-ink-900" data-testid="dealer-code">
              {code.code}
            </p>
            <p className="text-sm text-ink-700">Shops enter this code when they register, or open your link with it filled in. Shops you register yourself get it automatically.</p>
            <div className="flex flex-wrap gap-2">
              <a href={code.whatsapp} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-lg bg-leaf-700 px-4 text-sm font-semibold text-white">
                Share on WhatsApp
              </a>
              <Button
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard?.writeText(code.shareLink).catch(() => undefined);
                  setCopied(true);
                }}
              >
                {copied ? "Link copied" : "Copy link"}
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <Alert tone="warning">Your code is not active. Contact GoKesari.</Alert>
      )}

      <Card className="space-y-3 p-4" id="dealer-employees">
        <h2 className="text-base font-bold text-ink-900">Your employees</h2>
        <p className="text-sm text-ink-700">
          Add the people who visit shops for {legalName}. Each gets a code; shops they bring are counted for them. Commission is paid
          to you as the dealer.
        </p>
        {people.length === 0 ? <p className="text-sm text-ink-500">No employees yet.</p> : null}
        <ul className="divide-y divide-cream-200" data-testid="dealer-employees">
          {people.map((p) => (
            <li key={p.id} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">
                  <span className="font-semibold text-ink-900">{p.name}</span> <span className="text-ink-500">ID {p.employeeId}</span>{" "}
                  <Badge tone={p.status === "ACTIVE" ? "success" : "neutral"}>{p.status === "ACTIVE" ? "Active" : "Inactive"}</Badge>
                  {p.code ? <span className="block font-mono text-xs text-ink-700">{p.code}</span> : null}
                </span>
                <span className="flex gap-2">
                  {p.status === "ACTIVE" && p.code ? (
                    <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => showCode(p)}>
                      {shown?.id === p.id ? "Hide QR" : "QR & share"}
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => toggle(p)}>
                    {p.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
                  </Button>
                </span>
              </div>
              {shown?.id === p.id ? (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <div className="w-36 rounded-lg border border-cream-200 bg-white p-1 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: shown.code.qrSvg }} />
                  <a href={shown.code.whatsapp} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-lg bg-leaf-700 px-4 text-sm font-semibold text-white">
                    Share on WhatsApp
                  </a>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="grid gap-3 border-t border-cream-200 pt-3 sm:grid-cols-3">
          <Field label="Employee ID" hint="Your own ID for them.">
            <input className={inputClass} value={draft.employeeId} onChange={(e) => setDraft((d) => ({ ...d, employeeId: e.target.value }))} maxLength={48} />
          </Field>
          <Field label="Name">
            <input className={inputClass} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} maxLength={120} />
          </Field>
          <Field label="Mobile (optional)">
            <input className={inputClass} inputMode="numeric" value={draft.mobile} onChange={(e) => setDraft((d) => ({ ...d, mobile: e.target.value }))} maxLength={14} />
          </Field>
        </div>
        <Button onClick={add} disabled={busy !== null || !draft.employeeId.trim() || !draft.name.trim()}>
          {busy === "add" ? "Adding…" : "Add employee"}
        </Button>
      </Card>
    </div>
  );
}
