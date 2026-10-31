"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Money, inputClass } from "@/components/ui";
import { REFERRAL_CODE_LENGTH, REFERRAL_CODE_MIN_LENGTH } from "@/lib/referral-codes";

export interface ReferralRow {
  id: string;
  code: string;
  label: string | null;
  referrerName: string | null;
  status: string;
  expiresAt: string | null;
  shopCount: number;
}

export interface ReferralPerformanceRow {
  id: string;
  code: string;
  referrerName: string | null;
  shopCount: number;
  feesAttributedPaise: number;
}

const today = () => new Date().toISOString().slice(0, 10);

function statusTone(status: string) {
  return status === "ACTIVE" ? "success" : status === "EXPIRED" ? "warning" : "neutral";
}

/** Referral code management and performance (§4.3, §14, §23). */
export function ReferralManager({
  codes,
  performance,
}: {
  codes: ReferralRow[];
  performance: ReferralPerformanceRow[];
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [referrerName, setReferrerName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Row being edited: its id and the expiry date typed so far.
  const [editing, setEditing] = useState<{ id: string; expiresAt: string } | null>(null);

  async function create(): Promise<void> {
    const typed = code.trim();
    if (typed && !new RegExp(`^[A-Z0-9]{${REFERRAL_CODE_MIN_LENGTH},${REFERRAL_CODE_LENGTH}}$`).test(typed)) {
      setError(`A referral code is ${REFERRAL_CODE_MIN_LENGTH}–${REFERRAL_CODE_LENGTH} letters and digits. Leave it empty to generate one.`);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/referral-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: typed || null,
          label: label || null,
          referrerName: referrerName || null,
          expiresAt: expiresAt || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "That did not work.");
      }
      setNotice(`Referral code ${payload.code} created.`);
      setCode("");
      setLabel("");
      setReferrerName("");
      setExpiresAt("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function update(row: ReferralRow, patch: { status?: string; expiresAt?: string | null }, done: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/referral-codes/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "That did not work.");
      }
      setNotice(`${row.code}: ${done}.`);
      setEditing(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger" title="Could not save">{error}</Alert> : null}
      {notice ? <Alert tone="success" title="Saved">{notice}</Alert> : null}

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink-900">
          Create referral code
        </h3>
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block">
            <span className="text-xs text-ink-500">Code (empty = generate)</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              maxLength={REFERRAL_CODE_LENGTH}
              placeholder="Auto: 8 letters/digits"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-xs text-ink-500">Label</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Pune partner drive"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-xs text-ink-500">Referrer</span>
            <input
              value={referrerName}
              onChange={(e) => setReferrerName(e.target.value)}
              placeholder="Name of referrer"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-xs text-ink-500">Expires</span>
            <input
              type="date"
              value={expiresAt}
              min={today()}
              onChange={(e) => setExpiresAt(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
        <Button className="mt-3" disabled={busy} onClick={create}>
          Create code
        </Button>
      </Card>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-ink-900">
          Codes ({codes.length})
        </h3>
        {codes.length === 0 ? (
          <EmptyState title="No referral codes yet." />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-cream-100 text-xs uppercase text-ink-500">
                <tr>
                  <th className="px-4 py-2">Code</th>
                  <th className="px-4 py-2">Label</th>
                  <th className="px-4 py-2">Referrer</th>
                  <th className="px-4 py-2">Shops</th>
                  <th className="px-4 py-2">Fees attributed</th>
                  <th className="px-4 py-2">Expires</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {codes.map((c) => {
                  const perf = performance.find((p) => p.id === c.id);
                  const lapsed = Boolean(c.expiresAt && c.expiresAt < today());
                  const isEditing = editing?.id === c.id;
                  return (
                    <tr key={c.id}>
                      <td className="px-4 py-2 font-medium whitespace-nowrap text-ink-900">
                        {c.code}
                      </td>
                      <td className="px-4 py-2">{c.label ?? "—"}</td>
                      <td className="px-4 py-2">{c.referrerName ?? "—"}</td>
                      <td className="px-4 py-2">{c.shopCount}</td>
                      <td className="px-4 py-2">
                        <Money paise={Number(perf?.feesAttributedPaise ?? 0)} />
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {isEditing ? (
                          <input
                            type="date"
                            aria-label={`New expiry for ${c.code}`}
                            value={editing.expiresAt}
                            min={today()}
                            onChange={(e) => setEditing({ id: c.id, expiresAt: e.target.value })}
                            className={inputClass}
                          />
                        ) : c.expiresAt ? (
                          <span className={lapsed ? "text-red-700" : undefined}>
                            {c.expiresAt}
                            {lapsed ? " (lapsed)" : ""}
                          </span>
                        ) : (
                          "Never"
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-2">
                          {isEditing ? (
                            <>
                              <Button
                                size="sm"
                                disabled={busy || !editing.expiresAt}
                                onClick={() => update(c, { expiresAt: editing.expiresAt }, `expiry set to ${editing.expiresAt}`)}
                              >
                                Save
                              </Button>
                              {c.expiresAt ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={() => update(c, { expiresAt: null }, "expiry removed")}
                                >
                                  No expiry
                                </Button>
                              ) : null}
                              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy}
                                onClick={() => setEditing({ id: c.id, expiresAt: c.expiresAt && !lapsed ? c.expiresAt : "" })}
                              >
                                {c.expiresAt ? "Extend expiry" : "Set expiry"}
                              </Button>
                              {c.status === "ACTIVE" ? (
                                <Button
                                  size="sm"
                                  variant="danger"
                                  disabled={busy}
                                  onClick={() => {
                                    if (window.confirm(`Disable ${c.code}? New registrations will not accept it.`)) {
                                      void update(c, { status: "INACTIVE" }, "disabled");
                                    }
                                  }}
                                >
                                  Disable
                                </Button>
                              ) : (
                                <Button size="sm" disabled={busy} onClick={() => update(c, { status: "ACTIVE" }, "enabled")}>
                                  Enable
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </div>
  );
}
