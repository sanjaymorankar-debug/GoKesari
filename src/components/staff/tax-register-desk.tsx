"use client";

/**
 * docs/tax-register desk. Tabs: Settings (every tax setting and whether the CA approved its value),
 * Changes (proposals: the CA approves or sends back), CA items (questions: the Accountant answers,
 * the CA approves) and Switches (what the CA has cleared). The server decides every permission;
 * this only hides buttons.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";

interface Me {
  id: string;
  role: string;
  canPropose: boolean;
  canApprove: boolean;
}
export interface ParamRow {
  key: string;
  group: string;
  label: string;
  value: unknown;
  effectiveFrom: string | null;
  approved: boolean;
  approvedAtIst: string | null;
  rowId: string | null;
}
export interface ChangeRow {
  id: string;
  kind: string;
  title: string;
  status: string;
  reason: string;
  legalReference: string | null;
  payload: Record<string, unknown>;
  currentValue: unknown;
  proposedBy: string;
  proposedRole: string;
  decisionNote: string | null;
  applyError: string | null;
  createdIst: string;
  decidedIst: string | null;
}
export interface ItemRow {
  id: string;
  ref: string;
  area: string;
  title: string;
  question: string;
  blocks: string[];
  status: string;
  priority: string;
  dueOn: string | null;
  answer: string | null;
  answeredBy: string | null;
  approvedIst: string | null;
  notes: { id: string; kind: string; body: string; authorRole: string | null; atIst: string }[];
}
export interface SwitchRow {
  key: string;
  cleared: boolean;
  waitingOn: string[];
  approvedBy: string[];
}

const TABS = [
  { key: "settings", label: "Settings" },
  { key: "changes", label: "Changes" },
  { key: "items", label: "CA items" },
  { key: "switches", label: "Switches" },
] as const;

const show = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v));
const tone = (s: string): "success" | "warning" | "danger" | "info" | "neutral" =>
  s === "APPLIED" || s === "APPROVED" ? "success" : s === "SENT_BACK" || s === "NEEDS_INFO" || s === "APPLY_FAILED" ? "danger" : s === "SUBMITTED" ? "warning" : s === "OPEN" ? "info" : "neutral";

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
    throw new Error((fields ? Object.values(fields).join(" ") : null) ?? payload?.error?.message ?? "That did not work.");
  }
  return payload;
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "success", text: done });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    } finally {
      setBusy(false);
    }
  }
  return { busy, msg, run };
}

export function TaxRegisterDesk(props: { tab: string; me: Me; ruleFields: Record<string, string[]>; parameters: ParamRow[]; changes: ChangeRow[]; items: ItemRow[]; switches: SwitchRow[] }) {
  const pending = props.changes.filter((c) => c.status === "SUBMITTED" || c.status === "APPLY_FAILED").length;
  const itemsWaiting = props.items.filter((i) => i.status === "SUBMITTED").length;
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-2" aria-label="Tax register">
        {TABS.map((t) => (
          <Link key={t.key} href={`/staff/tax?tab=${t.key}`} className={`rounded-full px-3 py-1 text-sm ${props.tab === t.key ? "bg-ink-900 text-white" : "bg-cream-200 text-ink-700"}`}>
            {t.label}
            {t.key === "changes" && pending ? ` (${pending})` : ""}
            {t.key === "items" && itemsWaiting ? ` (${itemsWaiting})` : ""}
          </Link>
        ))}
      </nav>
      {props.tab === "settings" && <Settings me={props.me} parameters={props.parameters} ruleFields={props.ruleFields} />}
      {props.tab === "changes" && <Changes me={props.me} changes={props.changes} />}
      {props.tab === "items" && <Items me={props.me} items={props.items} />}
      {props.tab === "switches" && <Switches switches={props.switches} />}
    </div>
  );
}

/* ------------------------------------------------------------------ settings */

function Settings({ me, parameters, ruleFields }: { me: Me; parameters: ParamRow[]; ruleFields: Record<string, string[]> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const { busy, msg, run } = useAction();
  const groups = useMemo(() => {
    const m = new Map<string, ParamRow[]>();
    for (const p of parameters) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()];
  }, [parameters]);
  const notApproved = parameters.filter((p) => !p.approved).length;
  return (
    <div className="space-y-4">
      <Alert tone={notApproved ? "warning" : "success"} title={notApproved ? `${notApproved} of ${parameters.length} settings not approved by the CA` : "Every setting is approved by the CA"}>
        A value is approved while it still equals what the CA approved. Changing it (here or on an admin screen) needs a new approval.
      </Alert>
      {groups.map(([group, rows]) => (
        <Card key={group} className="p-4">
          <h3 className="mb-2 font-semibold text-ink-900">{group}</h3>
          <ul className="divide-y divide-cream-200">
            {rows.map((p) => (
              <li key={p.key} className="flex flex-wrap items-start gap-3 py-2 text-sm">
                {me.canPropose && !p.approved && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${p.label}`}
                    className="mt-1"
                    checked={picked.includes(p.key)}
                    onChange={(e) => setPicked((s) => (e.target.checked ? [...s, p.key] : s.filter((k) => k !== p.key)))}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink-800">{p.label}</p>
                  <p className="break-all font-mono text-xs text-ink-600">{show(p.value)}</p>
                  {p.effectiveFrom && <p className="text-xs text-ink-500">In force from {p.effectiveFrom}</p>}
                </div>
                {p.approved ? <Badge tone="success">CA approved{p.approvedAtIst ? ` · ${p.approvedAtIst}` : ""}</Badge> : <Badge tone="warning">Not approved by CA</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      ))}
      {me.canPropose && (
        <Card className="space-y-2 p-4">
          <h3 className="font-semibold text-ink-900">Send current values to the CA for approval</h3>
          <p className="text-sm text-ink-600">{picked.length ? `${picked.length} selected.` : "Tick the settings above whose current value the CA should approve as it is."}</p>
          <textarea className={inputClass} rows={2} placeholder="Reason / basis (at least 5 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button disabled={busy || !picked.length} onClick={() => run(() => call("/api/staff/tax/changes", "POST", { kind: "APPROVE_CURRENT", payload: { paramKeys: picked }, reason }), "Sent to the CA.").then(() => setPicked([]))}>
            Send for approval
          </Button>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        </Card>
      )}
      {me.canPropose && <ProposeForm ruleFields={ruleFields} />}
    </div>
  );
}

const KINDS = [
  { key: "RULE_FIELDS", label: "A tax field of the settings (rider TDS, default GST, composition, SAC …)" },
  { key: "STATUTORY_ROW", label: "A new dated statutory row (TCS s.52, TDS 194-O, s.9(5), GST on fees …)" },
  { key: "COMMISSION_TDS_ROW", label: "A new dated TDS-on-commission row" },
  { key: "GST_RULE", label: "A GST rule (numbering, thresholds, e-way bill …)" },
  { key: "HSN_RATES", label: "HSN fallback rates (CSV)" },
  { key: "PRODUCT_GST", label: "Product HSN / GST (CSV)" },
  { key: "FRANCHISE_GST", label: "Franchise fee GST" },
] as const;

function ProposeForm({ ruleFields }: { ruleFields: Record<string, string[]> }) {
  const [kind, setKind] = useState<(typeof KINDS)[number]["key"]>("RULE_FIELDS");
  const [f, setF] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [legal, setLegal] = useState("");
  const { busy, msg, run } = useAction();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const json = (v: string | undefined, fallback: unknown) => {
    if (!v || !v.trim()) return fallback;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  const pctToBp = (v: string | undefined) => (v === undefined || v === "" ? null : Math.round(Number(v) * 100));

  function body() {
    switch (kind) {
      case "RULE_FIELDS":
        return { payload: { ruleKey: f.ruleKey, values: { [f.field ?? ""]: json(f.value, null) } } };
      case "STATUTORY_ROW":
        return { payload: { key: f.key, label: f.label, enabled: f.enabled !== "false", rateBp: pctToBp(f.rate), params: json(f.params, {}), effectiveFrom: f.from, legalReference: legal || null } };
      case "COMMISSION_TDS_ROW":
        return { payload: { payeeType: f.payeeType ?? "ANY", panStatus: f.panStatus ?? "PAN_OK", rateBp: pctToBp(f.rate), thresholdPaise: Math.round(Number(f.threshold || "0") * 100), mode: f.mode ?? "CATCH_UP", section: f.section, effectiveFrom: f.from } };
      case "GST_RULE":
        return { payload: { key: f.key, value: json(f.value, null), effectiveFrom: f.from } };
      case "HSN_RATES":
      case "PRODUCT_GST":
        return { payload: {}, csv: f.csv ?? "" };
      case "FRANCHISE_GST":
        return { payload: { gstRateBp: pctToBp(f.rate) } };
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <h3 className="font-semibold text-ink-900">Propose a change</h3>
      <select className={inputClass} value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setF({}); }} aria-label="Kind of change">
        {KINDS.map((k) => (
          <option key={k.key} value={k.key}>{k.label}</option>
        ))}
      </select>
      {kind === "RULE_FIELDS" && (
        <div className="grid gap-2 sm:grid-cols-3">
          <select className={inputClass} value={f.ruleKey ?? ""} onChange={set("ruleKey")} aria-label="Setting">
            <option value="">Setting…</option>
            {Object.keys(ruleFields).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <select className={inputClass} value={f.field ?? ""} onChange={set("field")} aria-label="Field">
            <option value="">Field…</option>
            {(ruleFields[f.ruleKey ?? ""] ?? []).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input className={inputClass} placeholder='New value (100, true, "HOLD", {…})' value={f.value ?? ""} onChange={set("value")} />
        </div>
      )}
      {kind === "STATUTORY_ROW" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <select className={inputClass} value={f.key ?? ""} onChange={set("key")} aria-label="Statutory key">
            <option value="">Statutory key…</option>
            {["GST_TCS_SEC52", "IT_TDS_194O", "GST_S95_RESTAURANT", "GST_S95_LOCAL_DELIVERY", "UNREGISTERED_SELLER_RULES", "PLATFORM_FEE_GST", "IT_TDS_194H", "IT_TDS_194J"].map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input className={inputClass} placeholder="Label" value={f.label ?? ""} onChange={set("label")} />
          <input className={inputClass} placeholder="Rate % (empty = none)" value={f.rate ?? ""} onChange={set("rate")} inputMode="decimal" />
          <input className={inputClass} type="date" aria-label="Effective from" value={f.from ?? ""} onChange={set("from")} />
          <select className={inputClass} value={f.enabled ?? "true"} onChange={set("enabled")} aria-label="Enabled">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
          <textarea className={inputClass} rows={2} placeholder='Params JSON, e.g. {"noPanRateBp":500}' value={f.params ?? ""} onChange={set("params")} />
        </div>
      )}
      {kind === "COMMISSION_TDS_ROW" && (
        <div className="grid gap-2 sm:grid-cols-3">
          <select className={inputClass} value={f.payeeType ?? "ANY"} onChange={set("payeeType")} aria-label="Payee type">
            {["ANY", "INDIVIDUAL", "FIRM", "COMPANY"].map((k) => <option key={k}>{k}</option>)}
          </select>
          <select className={inputClass} value={f.panStatus ?? "PAN_OK"} onChange={set("panStatus")} aria-label="PAN status">
            <option value="PAN_OK">With PAN</option>
            <option value="NO_PAN">No PAN</option>
          </select>
          <select className={inputClass} value={f.mode ?? "CATCH_UP"} onChange={set("mode")} aria-label="Mode">
            <option value="CATCH_UP">Catch up</option>
            <option value="EXCESS_ONLY">Excess only</option>
          </select>
          <input className={inputClass} placeholder="Rate %" value={f.rate ?? ""} onChange={set("rate")} inputMode="decimal" />
          <input className={inputClass} placeholder="Annual threshold ₹" value={f.threshold ?? ""} onChange={set("threshold")} inputMode="decimal" />
          <input className={inputClass} type="date" aria-label="Effective from" value={f.from ?? ""} onChange={set("from")} />
          <input className={`${inputClass} sm:col-span-3`} placeholder="Section (e.g. 194H / s.393)" value={f.section ?? ""} onChange={set("section")} />
        </div>
      )}
      {kind === "GST_RULE" && (
        <div className="grid gap-2 sm:grid-cols-3">
          <input className={inputClass} placeholder="Rule key (e.g. documentNumbering)" value={f.key ?? ""} onChange={set("key")} />
          <input className={inputClass} type="date" aria-label="Effective from" value={f.from ?? ""} onChange={set("from")} />
          <textarea className={`${inputClass} sm:col-span-3`} rows={2} placeholder="Value JSON" value={f.value ?? ""} onChange={set("value")} />
        </div>
      )}
      {(kind === "HSN_RATES" || kind === "PRODUCT_GST") && (
        <textarea
          className={inputClass}
          rows={6}
          placeholder={kind === "HSN_RATES" ? "hsn,rate%,cess%,description,effective_from\n0401,5,0,Milk,2026-12-01" : "product_id,hsn,gst%\n<uuid>,0405,12"}
          value={f.csv ?? ""}
          onChange={set("csv")}
        />
      )}
      {kind === "FRANCHISE_GST" && <input className={inputClass} placeholder="GST %" value={f.rate ?? ""} onChange={set("rate")} inputMode="decimal" />}
      <textarea className={inputClass} rows={2} placeholder="Reason / CA advice (at least 5 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <input className={inputClass} placeholder="Legal reference (notification, section) — optional" value={legal} onChange={(e) => setLegal(e.target.value)} />
      <Button disabled={busy} onClick={() => run(() => call("/api/staff/tax/changes", "POST", { kind, reason, legalReference: legal || null, ...body() }), "Proposed. It waits for the CA.")}>
        Propose
      </Button>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
    </Card>
  );
}

/* ------------------------------------------------------------------- changes */

function Changes({ me, changes }: { me: Me; changes: ChangeRow[] }) {
  if (!changes.length) return <EmptyState title="No changes proposed yet" description="The Accountant proposes on the Settings tab." />;
  return (
    <div className="space-y-3">
      {changes.map((c) => (
        <ChangeCard key={c.id} me={me} c={c} />
      ))}
    </div>
  );
}

function ChangeCard({ me, c }: { me: Me; c: ChangeRow }) {
  const [note, setNote] = useState("");
  const [payload, setPayload] = useState(JSON.stringify(c.payload, null, 2));
  const [reason, setReason] = useState(c.reason);
  const { busy, msg, run } = useAction();
  const mine = c.proposedBy === me.id;
  const open = c.status === "SUBMITTED" || c.status === "APPLY_FAILED";
  return (
    <Card className="space-y-2 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone(c.status)}>{c.status.replace("_", " ")}</Badge>
        <span className="font-medium text-ink-900">{c.title}</span>
      </div>
      <p className="text-xs text-ink-500">
        {c.kind} · proposed by {mine ? "you" : c.proposedRole} · {c.createdIst}
        {c.decidedIst ? ` · decided ${c.decidedIst}` : ""}
      </p>
      <p className="text-ink-700">{c.reason}</p>
      {c.legalReference && <p className="text-xs text-ink-600">Legal reference: {c.legalReference}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-ink-600">Now</p>
          <pre className="max-h-40 overflow-auto rounded bg-cream-100 p-2 text-xs">{show(c.currentValue)}</pre>
        </div>
        <div>
          <p className="text-xs font-medium text-ink-600">Proposed</p>
          <pre className="max-h-40 overflow-auto rounded bg-cream-100 p-2 text-xs">{JSON.stringify(c.payload, null, 2)}</pre>
        </div>
      </div>
      {c.decisionNote && <Alert tone={c.status === "SENT_BACK" ? "warning" : "info"}>CA: {c.decisionNote}</Alert>}
      {c.applyError && <Alert tone="danger">Could not apply: {c.applyError}</Alert>}
      {me.canApprove && open && !mine && (
        <div className="space-y-2">
          <textarea className={inputClass} rows={2} placeholder="Note (needed to send back)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => run(() => call(`/api/staff/tax/changes/${c.id}`, "POST", { action: "approve", note: note || null }), "Approved and applied.")}>Approve and apply</Button>
            <Button variant="secondary" disabled={busy || note.trim().length < 3} onClick={() => run(() => call(`/api/staff/tax/changes/${c.id}`, "POST", { action: "sendBack", note }), "Sent back.")}>Send back</Button>
          </div>
        </div>
      )}
      {mine && c.status === "SENT_BACK" && (
        <div className="space-y-2">
          <textarea className={`${inputClass} font-mono text-xs`} rows={6} aria-label="Proposed values (JSON)" value={payload} onChange={(e) => setPayload(e.target.value)} />
          <textarea className={inputClass} rows={2} aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button disabled={busy} onClick={() => run(async () => call(`/api/staff/tax/changes/${c.id}`, "POST", { action: "resubmit", kind: c.kind, payload: JSON.parse(payload), reason, legalReference: c.legalReference }), "Submitted again.")}>
            Submit again
          </Button>
        </div>
      )}
      {(mine || me.role === "ADMIN") && (open || c.status === "SENT_BACK") && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => call(`/api/staff/tax/changes/${c.id}`, "POST", { action: "withdraw" }), "Withdrawn.")}>Withdraw</Button>
      )}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
    </Card>
  );
}

/* ------------------------------------------------------------------ CA items */

function Items({ me, items }: { me: Me; items: ItemRow[] }) {
  const [filter, setFilter] = useState("ACTIVE");
  const shown = items.filter((i) => (filter === "ACTIVE" ? i.status !== "CLOSED" : filter === "ALL" ? true : i.status === filter));
  return (
    <div className="space-y-3">
      <select className={`${inputClass} max-w-xs`} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter">
        <option value="ACTIVE">Not closed</option>
        <option value="OPEN">Open</option>
        <option value="SUBMITTED">Waiting for the CA</option>
        <option value="NEEDS_INFO">Sent back</option>
        <option value="APPROVED">Approved</option>
        <option value="CLOSED">Closed</option>
        <option value="ALL">All</option>
      </select>
      {shown.length ? shown.map((i) => <ItemCard key={i.id} me={me} i={i} />) : <EmptyState title="No items" description="Items are added here or loaded from the owner's file." />}
      {me.canPropose && <NewItem />}
    </div>
  );
}

function ItemCard({ me, i }: { me: Me; i: ItemRow }) {
  const [answer, setAnswer] = useState(i.answer ?? "");
  const [text, setText] = useState("");
  const [blocks, setBlocks] = useState(i.blocks.join(", "));
  const { busy, msg, run } = useAction();
  const act = (action: string, done: string) => run(() => call(`/api/staff/tax/ca-items/${i.id}`, "POST", { action, text: text || null }), done).then(() => setText(""));
  const ownAnswer = i.answeredBy === me.id;
  return (
    <Card className="space-y-2 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-ink-600">{i.ref}</span>
        <Badge tone={tone(i.status)}>{i.status.replace("_", " ")}</Badge>
        {i.priority === "HIGH" && <Badge tone="danger">High</Badge>}
        <span className="font-medium text-ink-900">{i.title}</span>
      </div>
      <p className="whitespace-pre-wrap text-ink-700">{i.question}</p>
      <p className="text-xs text-ink-500">
        {i.area}
        {i.dueOn ? ` · due ${i.dueOn}` : ""}
        {i.blocks.length ? ` · holds back: ${i.blocks.join(", ")}` : ""}
        {i.approvedIst ? ` · approved ${i.approvedIst}` : ""}
      </p>
      {me.canPropose && i.status !== "CLOSED" ? (
        <div className="space-y-2">
          <textarea className={inputClass} rows={3} aria-label={`Answer to ${i.ref}`} placeholder="Answer (from the CA's advice)" value={answer} onChange={(e) => setAnswer(e.target.value)} />
          <input className={inputClass} aria-label="Holds back (comma-separated switch keys)" value={blocks} onChange={(e) => setBlocks(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => call(`/api/staff/tax/ca-items/${i.id}`, "PATCH", { answer: answer || null, blocks: blocks.split(",").map((b) => b.trim()).filter(Boolean) }), "Saved.")}>Save</Button>
            <Button size="sm" disabled={busy || !answer.trim()} onClick={() => run(async () => { await call(`/api/staff/tax/ca-items/${i.id}`, "PATCH", { answer }); await call(`/api/staff/tax/ca-items/${i.id}`, "POST", { action: "SUBMIT" }); }, "Sent to the CA.")}>Save and send to CA</Button>
          </div>
        </div>
      ) : (
        i.answer && <p className="whitespace-pre-wrap rounded bg-cream-100 p-2 text-ink-800">{i.answer}</p>
      )}
      <textarea className={inputClass} rows={2} placeholder="Note / reason" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        {me.canApprove && !ownAnswer && i.status === "SUBMITTED" && <Button size="sm" disabled={busy} onClick={() => act("APPROVE", "Approved.")}>Approve</Button>}
        {me.canApprove && !ownAnswer && (i.status === "SUBMITTED" || i.status === "APPROVED") && (
          <Button size="sm" variant="secondary" disabled={busy || text.trim().length < 3} onClick={() => act("SEND_BACK", "Sent back.")}>Send back</Button>
        )}
        {me.canPropose && i.status !== "CLOSED" && <Button size="sm" variant="ghost" disabled={busy || text.trim().length < 3} onClick={() => act("CLOSE", "Closed.")}>Close</Button>}
        {me.canPropose && (i.status === "CLOSED" || i.status === "APPROVED") && <Button size="sm" variant="ghost" disabled={busy || text.trim().length < 3} onClick={() => act("REOPEN", "Reopened.")}>Reopen</Button>}
        <Button size="sm" variant="ghost" disabled={busy || text.trim().length < 2} onClick={() => act("NOTE", "Note added.")}>Add note</Button>
      </div>
      {i.notes.length > 0 && (
        <ul className="space-y-1 border-t border-cream-200 pt-2 text-xs text-ink-600">
          {i.notes.map((n) => (
            <li key={n.id}>
              <span className="font-medium">{n.authorRole ?? "—"}</span> · {n.kind.replace("_", " ").toLowerCase()} · {n.atIst}: {n.body}
            </li>
          ))}
        </ul>
      )}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
    </Card>
  );
}

function NewItem() {
  const [f, setF] = useState({ ref: "", title: "", question: "", blocks: "", priority: "NORMAL", dueOn: "" });
  const { busy, msg, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Card className="space-y-2 p-4">
      <h3 className="font-semibold text-ink-900">Add a CA item</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        <input className={inputClass} placeholder="Ref (e.g. GST-13)" value={f.ref} onChange={set("ref")} />
        <select className={inputClass} value={f.priority} onChange={set("priority")} aria-label="Priority">
          <option value="HIGH">High</option>
          <option value="NORMAL">Normal</option>
          <option value="LOW">Low</option>
        </select>
        <input className={inputClass} type="date" aria-label="Due on" value={f.dueOn} onChange={set("dueOn")} />
      </div>
      <input className={inputClass} placeholder="Title" value={f.title} onChange={set("title")} />
      <textarea className={inputClass} rows={3} placeholder="Question" value={f.question} onChange={set("question")} />
      <input className={inputClass} placeholder="Holds back (comma-separated, e.g. tcs_engine, statutory:GST_TCS_SEC52)" value={f.blocks} onChange={set("blocks")} />
      <Button
        disabled={busy}
        onClick={() =>
          run(
            () => call("/api/staff/tax/ca-items", "POST", { ref: f.ref.toUpperCase(), title: f.title, question: f.question, priority: f.priority, dueOn: f.dueOn || null, blocks: f.blocks.split(",").map((b) => b.trim()).filter(Boolean) }),
            "Added.",
          )
        }
      >
        Add
      </Button>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
    </Card>
  );
}

/* ------------------------------------------------------------------ switches */

function Switches({ switches }: { switches: SwitchRow[] }) {
  if (!switches.length) return <EmptyState title="No switches named yet" description="CA items list the switches they hold back." />;
  return (
    <Card className="p-4">
      <p className="mb-2 text-sm text-ink-600">Cleared means every CA item that holds the switch back is approved. Nothing is switched on here — an admin does that after the owner says go.</p>
      <ul className="divide-y divide-cream-200 text-sm">
        {switches.map((s) => (
          <li key={s.key} className="flex flex-wrap items-center gap-2 py-2">
            <span className="font-mono">{s.key}</span>
            {s.cleared ? <Badge tone="success">Cleared by CA</Badge> : <Badge tone="warning">Waiting on {s.waitingOn.join(", ")}</Badge>}
            {s.approvedBy.length > 0 && <span className="text-xs text-ink-500">approved: {s.approvedBy.join(", ")}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
