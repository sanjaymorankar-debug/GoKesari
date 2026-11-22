"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

type DocKind = "SHOP_OWNER_CONSENT" | "FROM_DEALER_CONSENT" | "TO_DEALER_CONSENT" | "MEMBER_CONSENT" | "OTHER";

const DOC_LABELS: Record<DocKind, string> = {
  SHOP_OWNER_CONSENT: "Shop owner's signed consent",
  FROM_DEALER_CONSENT: "Old dealer / franchise owner's signed consent",
  TO_DEALER_CONSENT: "New dealer / franchise owner's signed consent",
  MEMBER_CONSENT: "Team member's signed consent",
  OTHER: "Other supporting document",
};

interface Target {
  id: string;
  name: string;
  members: { id: string; name: string; teamRole: string }[];
}

interface MoveRequest {
  id: string;
  kind: "SHOPS" | "MEMBER";
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  reason: string;
  requestedBy: string;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  toDealerName: string | null;
  fromDealerName: string | null;
  memberName: string | null;
  toMemberName: string | null;
  shops: { id: string; name: string; fromDealerName: string | null }[];
  documents: { id: string; kind: DocKind; shopId: string | null; fileName: string; sizeBytes: number }[];
  missing: { kind: DocKind; shopId: string | null; label: string }[];
  result: { shops?: { shopId: string; franchise: string }[]; keptCode?: string | null } | null;
}

interface ShopHit {
  id: string;
  name: string;
  status: string;
  code: string | null;
  dealerName: string | null;
}

const STATUS_TONE = { PENDING: "warning", APPROVED: "success", REJECTED: "danger", CANCELLED: "neutral" } as const;
const istDate = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");

export function ReferralMovesAdmin({ userId, requests, targets }: { userId: string; requests: MoveRequest[]; targets: Target[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kind, setKind] = useState<"SHOPS" | "MEMBER">("SHOPS");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ShopHit[]>([]);
  const [picked, setPicked] = useState<ShopHit[]>([]);
  const [fromDealerId, setFromDealerId] = useState("");
  const [memberId, setMemberId] = useState("");
  const [toDealerId, setToDealerId] = useState("");
  const [toMemberId, setToMemberId] = useState("");
  const [reason, setReason] = useState("");

  const toDealer = targets.find((t) => t.id === toDealerId);
  const fromDealer = targets.find((t) => t.id === fromDealerId);

  async function call(url: string, init: RequestInit, done: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, init);
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setNotice(done);
      router.refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function search() {
    setError(null);
    const res = await fetch(`/api/admin/referral-moves/shops?q=${encodeURIComponent(q)}`);
    const payload = await res.json().catch(() => null);
    if (!res.ok) return setError(payload?.error?.message ?? "Search failed.");
    setHits(payload.shops ?? []);
  }

  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card className="space-y-3 p-4" data-testid="referral-move-new">
        <h2 className="text-base font-bold text-ink-900">New move request</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant={kind === "SHOPS" ? "primary" : "secondary"} onClick={() => setKind("SHOPS")}>
            Shops (add / move a referral code)
          </Button>
          <Button variant={kind === "MEMBER" ? "primary" : "secondary"} onClick={() => setKind("MEMBER")}>
            A team member with his code and shops
          </Button>
        </div>

        {kind === "SHOPS" ? (
          <div className="space-y-2">
            <Field label="Find shops (name, phone or shop id)">
              <div className="flex gap-2">
                <input className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? void search() : null)} />
                <Button variant="secondary" disabled={q.trim().length < 2} onClick={() => void search()}>
                  Search
                </Button>
              </div>
            </Field>
            {hits.length ? (
              <ul className="divide-y divide-ink-100 rounded border border-ink-100 text-sm">
                {hits.map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-2 p-2">
                    <span>
                      <strong>{h.name}</strong> · {h.dealerName ? `with ${h.dealerName}` : "no referral code"}
                      {h.code ? ` · code ${h.code}` : ""}
                    </span>
                    <Button variant="secondary" disabled={picked.some((p) => p.id === h.id) || picked.length >= 50} onClick={() => setPicked([...picked, h])}>
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {picked.length ? (
              <p className="text-sm text-ink-700">
                Chosen ({picked.length}):{" "}
                {picked.map((p) => (
                  <button key={p.id} type="button" className="mr-2 underline" onClick={() => setPicked(picked.filter((x) => x.id !== p.id))} title="Remove">
                    {p.name} ✕
                  </button>
                ))}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Current dealer / franchise">
              <select className={inputClass} value={fromDealerId} onChange={(e) => (setFromDealerId(e.target.value), setMemberId(""))}>
                <option value="">Choose…</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Team member to move">
              <select className={inputClass} value={memberId} onChange={(e) => setMemberId(e.target.value)} disabled={!fromDealer}>
                <option value="">Choose…</option>
                {fromDealer?.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.teamRole === "TEAM_LEAD" ? "team lead" : "agent"})
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Move to dealer / franchise">
            <select className={inputClass} value={toDealerId} onChange={(e) => (setToDealerId(e.target.value), setToMemberId(""))}>
              <option value="">Choose…</option>
              {targets
                .filter((t) => t.id !== fromDealerId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={kind === "SHOPS" ? "Whose referral code" : "Joins under"}>
            <select className={inputClass} value={toMemberId} onChange={(e) => setToMemberId(e.target.value)} disabled={!toDealer}>
              <option value="">{kind === "SHOPS" ? "The dealer's own code" : "Reports to the dealer"}</option>
              {toDealer?.members
                .filter((m) => kind === "SHOPS" || m.teamRole === "TEAM_LEAD")
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.teamRole === "TEAM_LEAD" ? "team lead" : "agent"})
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <Field label="Reason (logged)">
          <textarea className={inputClass} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the shop / person changes team" />
        </Field>
        <Button
          disabled={busy || !toDealerId || reason.trim().length < 10 || (kind === "SHOPS" ? picked.length === 0 : !memberId)}
          onClick={async () => {
            const body = kind === "SHOPS" ? { kind, shopIds: picked.map((p) => p.id), toDealerId, toMemberId: toMemberId || null, reason } : { kind, memberId, toDealerId, toMemberId: toMemberId || null, reason };
            if (await call("/api/admin/referral-moves", json(body), "Request raised — upload the signed consent letters below; a different admin approves it.")) {
              setPicked([]);
              setHits([]);
              setReason("");
            }
          }}
        >
          Raise request
        </Button>
      </Card>

      <h2 className="text-base font-bold text-ink-900">Requests</h2>
      {requests.length === 0 ? <p className="text-sm text-ink-600">No move requests yet.</p> : null}
      {requests.map((r) => (
        <Card key={r.id} className="space-y-2 p-4" data-testid="referral-move-request">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[r.status]}>{r.status.toLowerCase()}</Badge>
            <span className="text-sm font-semibold text-ink-900">
              {r.kind === "SHOPS" ? `${r.shops.length} shop${r.shops.length === 1 ? "" : "s"}` : `${r.memberName ?? "Team member"} (from ${r.fromDealerName ?? "?"})`} → {r.toDealerName}
              {r.toMemberName ? (r.kind === "SHOPS" ? ` · ${r.toMemberName}'s code` : ` · under ${r.toMemberName}`) : r.kind === "SHOPS" ? " · dealer's own code" : ""}
            </span>
            <span className="text-xs text-ink-500">raised {istDate(r.requestedAt)} IST</span>
          </div>
          {r.kind === "SHOPS" ? <p className="text-sm text-ink-700">{r.shops.map((s) => `${s.name} (${s.fromDealerName ? `from ${s.fromDealerName}` : "no code yet"})`).join(" · ")}</p> : null}
          <p className="text-sm text-ink-700">Reason: {r.reason}</p>
          {r.documents.length ? (
            <ul className="text-sm text-ink-700">
              {r.documents.map((d) => (
                <li key={d.id}>
                  <a className="underline" href={`/api/admin/referral-moves/${r.id}/documents/${d.id}`} target="_blank" rel="noreferrer">
                    {DOC_LABELS[d.kind]}
                    {d.shopId ? ` — ${r.shops.find((s) => s.id === d.shopId)?.name ?? "shop"}` : ""}: {d.fileName}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {r.status === "PENDING" ? <PendingActions r={r} userId={userId} busy={busy} call={call} /> : null}
          {r.decisionNote ? (
            <p className="text-sm text-ink-600">
              Decision{r.decidedAt ? ` (${istDate(r.decidedAt)} IST)` : ""}: {r.decisionNote}
              {r.result?.keptCode ? ` · keeps code ${r.result.keptCode}` : ""}
            </p>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

function PendingActions({ r, userId, busy, call }: { r: MoveRequest; userId: string; busy: boolean; call: (url: string, init: RequestInit, done: string) => Promise<boolean> }) {
  const [docKind, setDocKind] = useState<DocKind>(r.missing[0]?.kind ?? "OTHER");
  const [shopId, setShopId] = useState<string>(r.missing.find((m) => m.shopId)?.shopId ?? r.shops[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const mine = r.requestedBy === userId;
  const decide = (action: "approve" | "reject" | "cancel", done: string) =>
    call(`/api/admin/referral-moves/${r.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, note }) }, done);
  return (
    <div className="space-y-2 border-t border-ink-100 pt-2">
      {r.missing.length ? (
        <Alert tone="warning">Missing before approval: {r.missing.map((m) => (m.shopId ? `${m.label} — ${r.shops.find((s) => s.id === m.shopId)?.name ?? "shop"}` : m.label)).join("; ")}</Alert>
      ) : (
        <p className="text-sm text-ink-700">All consent letters are in.</p>
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        <select className={inputClass} value={docKind} onChange={(e) => setDocKind(e.target.value as DocKind)} aria-label="Document type">
          {(Object.keys(DOC_LABELS) as DocKind[])
            .filter((k) => (r.kind === "SHOPS" ? k !== "MEMBER_CONSENT" : k !== "SHOP_OWNER_CONSENT"))
            .map((k) => (
              <option key={k} value={k}>
                {DOC_LABELS[k]}
              </option>
            ))}
        </select>
        {docKind === "SHOP_OWNER_CONSENT" ? (
          <select className={inputClass} value={shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Shop">
            {r.shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <span />
        )}
        <input className={inputClass} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Signed consent file" />
      </div>
      <Button
        variant="secondary"
        disabled={busy || !file}
        onClick={async () => {
          const form = new FormData();
          form.set("file", file!);
          form.set("kind", docKind);
          if (docKind === "SHOP_OWNER_CONSENT") form.set("shopId", shopId);
          if (await call(`/api/admin/referral-moves/${r.id}/documents`, { method: "POST", body: form }, "Document uploaded.")) setFile(null);
        }}
      >
        Upload document
      </Button>
      <Field label={mine ? "Note (to cancel your request)" : "Decision note (logged)"}>
        <input className={inputClass} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        {mine ? (
          <>
            <p className="text-sm text-ink-600">You raised this request — a different admin approves or rejects it.</p>
            <Button variant="secondary" disabled={busy || note.trim().length < 5} onClick={() => void decide("cancel", "Request cancelled.")}>
              Cancel request
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy || note.trim().length < 5 || r.missing.length > 0} onClick={() => void decide("approve", "Approved — the move is done. Earlier commission stays with the old team.")}>
              Approve and move
            </Button>
            <Button variant="danger" disabled={busy || note.trim().length < 5} onClick={() => void decide("reject", "Request rejected.")}>
              Reject
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
