"use client";
/**
 * Admin → Dealers → Promote (owner, 28-Nov-2026). Search a shop or dealer; promote a live shop's owner to dealer
 * (four-eye) or an approved dealer to super dealer; approve / reject dealers' own super dealer requests.
 * Every reason is typed on the page (no browser pop-ups) and kept in the audit log.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

type Candidate = {
  ownerId: string | null;
  ownerName: string | null;
  mobileLast4: string | null;
  shops: { id: string; name: string; status: string; live: boolean }[];
  dealer: { id: string; legalName: string; status: string; source: string; code: string | null; wantsSuper: boolean } | null;
  isSuper: boolean;
  inSuperTeam: boolean;
};

type SuperRequest = { approvalId: string; dealerId: string | null; dealerName: string; contactName: string | null; reason: string; requestedBy: string; requestedByName: string | null; requestedAt: string };

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) + " IST";

export function DealerPromoteAdmin({ viewerId, isAdmin, superRequests }: { viewerId: string; isAdmin: boolean; superRequests: SuperRequest[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [alsoSuper, setAlsoSuper] = useState<Record<string, boolean>>({});

  async function search() {
    if (q.trim().length < 2) return setError("Type at least 2 characters: a shop or owner name, mobile, shop ID or dealer code.");
    setBusy("search");
    setError(null);
    try {
      const res = await fetch(`/api/admin/dealer-promotion?q=${encodeURIComponent(q.trim())}`);
      const p = await res.json().catch(() => null);
      if (!res.ok) throw new Error(p?.error?.message ?? "Search failed.");
      setResults((p?.data ?? p)?.results ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setBusy(null);
    }
  }

  async function post(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/dealer-promotion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const p = await res.json().catch(() => null);
      if (!res.ok) throw new Error(p?.error?.message ?? "That did not work.");
      setNotice((p?.data ?? p)?.message ?? "Done.");
      await search();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  async function decideSuper(item: SuperRequest, decision: "APPROVE" | "REJECT") {
    const comment = (reasons[`req:${item.approvalId}`] ?? "").trim();
    if (decision === "REJECT" && comment.length < 3) return setError("Say why you reject it (sent to the dealer).");
    setBusy(`req:${item.approvalId}:${decision}`);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/approvals/${item.approvalId}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, comment: comment || null }) });
      const p = await res.json().catch(() => null);
      if (!res.ok) throw new Error(p?.error?.message ?? "That did not work.");
      const data = p?.data ?? p;
      if (decision === "APPROVE" && data?.applyError) throw new Error(`Approved, but it could not be applied: ${data.applyError}`);
      setNotice(decision === "APPROVE" ? `${item.dealerName} is now a super dealer.` : `Rejected; ${item.dealerName} is told why.`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {superRequests.length ? (
        <Card className="space-y-3 p-4" data-testid="super-requests-pending">
          <h2 className="text-base font-bold text-ink-900">Super dealer requests ({superRequests.length})</h2>
          <p className="text-xs text-ink-600">An admin or operator approves or rejects. Nobody decides a request they raised.</p>
          {superRequests.map((r) => (
            <div key={r.approvalId} className="space-y-2 border-t border-cream-200 pt-3">
              <p className="text-sm text-ink-800">
                <strong>{r.dealerName}</strong>
                {r.contactName ? ` · ${r.contactName}` : ""} · asked by {r.requestedByName ?? "the dealer"} on {when(r.requestedAt)}
                {r.dealerId ? (
                  <>
                    {" · "}
                    <Link className="underline" href={`/admin/dealers/${r.dealerId}`}>
                      dealer page
                    </Link>
                  </>
                ) : null}
              </p>
              <p className="text-xs text-ink-600">{r.reason}</p>
              {r.requestedBy === viewerId ? (
                <p className="text-xs text-ink-600">You raised this request; a different admin or operator decides it.</p>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  <input className={`${inputClass} max-w-sm`} placeholder="Comment (needed to reject)" value={reasons[`req:${r.approvalId}`] ?? ""} onChange={(e) => setReasons((x) => ({ ...x, [`req:${r.approvalId}`]: e.target.value }))} maxLength={300} />
                  <Button size="sm" disabled={busy !== null} onClick={() => void decideSuper(r, "APPROVE")} data-testid="super-request-approve">
                    Approve
                  </Button>
                  <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void decideSuper(r, "REJECT")}>
                    Reject
                  </Button>
                </div>
              )}
            </div>
          ))}
        </Card>
      ) : null}

      <Card className="space-y-3 p-4" data-testid="dealer-promote-search">
        <h2 className="text-base font-bold text-ink-900">Find a shop or dealer</h2>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input className={`${inputClass} max-w-md`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Shop or owner name, mobile, shop ID or dealer code" aria-label="Search shops and dealers" maxLength={80} />
          <Button type="submit" disabled={busy !== null} data-testid="dealer-promote-search-go">
            {busy === "search" ? "Searching…" : "Search"}
          </Button>
        </form>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {results && !results.length ? <p className="text-sm text-ink-600">Nothing found.</p> : null}
        {(results ?? []).map((c, i) => {
          const key = c.ownerId ?? c.dealer?.id ?? String(i);
          const liveShop = c.shops.find((s) => s.live) ?? null;
          const d = c.dealer;
          const reason = reasons[key] ?? "";
          return (
            <div key={key} className="space-y-2 border-t border-cream-200 pt-3" data-testid="dealer-promote-result">
              <div className="flex flex-wrap items-center gap-2 text-sm text-ink-900">
                <strong>{c.ownerName ?? "Unknown owner"}</strong>
                {c.mobileLast4 ? <span className="text-ink-600">mobile ••••{c.mobileLast4}</span> : null}
                {c.isSuper ? <Badge tone="success">Super dealer</Badge> : null}
                {c.inSuperTeam ? <Badge tone="info">In a super dealer&apos;s team</Badge> : null}
                {d ? (
                  <Badge tone={d.status === "APPROVED" ? "success" : d.status === "PENDING" ? "warning" : "neutral"}>
                    Dealer {d.status.toLowerCase()}
                    {d.code ? ` · ${d.code}` : ""}
                  </Badge>
                ) : (
                  <Badge tone="neutral">Not a dealer</Badge>
                )}
                {d?.wantsSuper ? <Badge tone="info">Super dealer asked</Badge> : null}
              </div>
              {c.shops.length ? (
                <p className="text-xs text-ink-600">
                  Shops: {c.shops.map((s) => `${s.name} (${s.live ? "live" : s.status.toLowerCase()})`).join(" · ")}
                </p>
              ) : null}
              {d ? (
                <Link className="text-xs font-semibold text-kesari-800 underline" href={`/admin/dealers/${d.id}`}>
                  Open dealer page
                </Link>
              ) : null}
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Reason (kept in the audit log)">
                  <input className={`${inputClass} min-w-64`} value={reason} onChange={(e) => setReasons((x) => ({ ...x, [key]: e.target.value }))} maxLength={300} />
                </Field>
                {(!d || d.status === "DRAFT" || d.status === "PENDING") && liveShop ? (
                  <>
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" checked={!!alsoSuper[key]} onChange={(e) => setAlsoSuper((x) => ({ ...x, [key]: e.target.checked }))} />
                      Also make super dealer
                    </label>
                    <Button disabled={busy !== null} onClick={() => void post(`promote:${key}`, { action: "promoteShopOwner", shopId: liveShop.id, alsoSuper: !!alsoSuper[key], reason: reason || null })} data-testid="dealer-promote-make-dealer">
                      {busy === `promote:${key}` ? "Please wait…" : "Make dealer"}
                    </Button>
                  </>
                ) : null}
                {!d && !liveShop ? <span className="text-xs text-ink-600">No live shop — the owner can be promoted once a shop is live.</span> : null}
                {d?.status === "APPROVED" && !c.isSuper && !c.inSuperTeam ? (
                  <Button
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => (reason.trim().length < 5 ? setError("Give a reason (at least 5 characters) to make a super dealer.") : void post(`super:${key}`, { action: "makeSuper", dealerId: d.id, reason }))}
                    data-testid="dealer-promote-make-super"
                  >
                    {busy === `super:${key}` ? "Please wait…" : isAdmin ? "Make super dealer" : "Request super dealer"}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}
