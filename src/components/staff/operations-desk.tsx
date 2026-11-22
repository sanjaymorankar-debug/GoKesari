"use client";

/**
 * RBAC v2 Phase 6 Operations desk (docs/rbac/06-operations.md): the forms and buttons on
 * /staff/operations. The server decides who may act (src/server/rbac-operations) — this only hides
 * what would be refused.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";

type Msg = { tone: "success" | "danger"; text: string } | null;

async function send(url: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((payload as { error?: { message?: string } } | null)?.error?.message ?? "That did not work.");
  return payload;
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "success", text: ok });
      router.refresh();
      return true;
    } catch (error) {
      setMsg({ tone: "danger", text: error instanceof Error ? error.message : "That did not work." });
      return false;
    } finally {
      setBusy(false);
    }
  }
  const note = msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null;
  return { busy, run, note };
}

/** datetime-local value (IST wall clock) → ISO instant. */
const fromLocal = (v: string) => (v ? new Date(`${v}:00+05:30`).toISOString() : null);

/* ------------------------------------------------------------- tasks */

export interface PersonOption {
  id: string;
  name: string;
}

export function TaskComposer({ people, zones }: { people: PersonOption[]; zones: { zoneId: string; name: string }[] }) {
  const { busy, run, note } = useAction();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ kind: "SHOP_ONBOARDING", title: "", notes: "", priority: "NORMAL", assigneeUserId: "", zoneId: "", dueAt: "" });
  const [shopQuery, setShopQuery] = useState("");
  const [shops, setShops] = useState<{ id: string; name: string; pincode: string }[]>([]);
  const [shop, setShop] = useState<{ id: string; name: string } | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  async function findShops(q: string) {
    setShopQuery(q);
    if (q.trim().length < 2) return setShops([]);
    const res = await fetch(`/api/staff/operations/shops?q=${encodeURIComponent(q)}`);
    setShops(res.ok ? await res.json() : []);
  }

  if (!open) {
    return (
      <div>
        <Button onClick={() => setOpen(true)} disabled={people.length === 0}>
          New task
        </Button>
        {people.length === 0 ? <p className="mt-1 text-sm text-ink-600">No Operations Users yet: an admin gives the role first.</p> : null}
      </div>
    );
  }
  return (
    <Card className="grid gap-2 p-3">
      <h2 className="font-semibold">New task</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm">
          Kind
          <select className={inputClass} value={form.kind} onChange={set("kind")}>
            <option value="SHOP_ONBOARDING">Shop onboarding</option>
            <option value="CUSTOMER_ONBOARDING">Customer onboarding</option>
            <option value="FOLLOW_UP">Follow-up</option>
            <option value="DOCUMENT_COLLECTION">Document collection</option>
            <option value="OTHER">Other</option>
          </select>
        </label>
        <label className="text-sm">
          Assign to
          <select className={inputClass} value={form.assigneeUserId} onChange={set("assigneeUserId")}>
            <option value="">Choose…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm sm:col-span-2">
          Title
          <input className={inputClass} value={form.title} onChange={set("title")} maxLength={200} placeholder="e.g. Visit and register Shree Dairy, Kothrud" />
        </label>
        <label className="text-sm">
          Priority
          <select className={inputClass} value={form.priority} onChange={set("priority")}>
            <option value="LOW">Low</option>
            <option value="NORMAL">Normal</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </select>
        </label>
        <label className="text-sm">
          Due (IST)
          <input type="datetime-local" className={inputClass} value={form.dueAt} onChange={set("dueAt")} />
        </label>
        <label className="text-sm">
          Zone
          <select className={inputClass} value={form.zoneId} onChange={set("zoneId")}>
            <option value="">None</option>
            {zones.map((z) => (
              <option key={z.zoneId} value={z.zoneId}>
                {z.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Shop (optional)
          {shop ? (
            <span className="flex items-center gap-2 py-2">
              <Badge tone="info">{shop.name}</Badge>
              <button type="button" className="text-sm text-kesari-800 underline" onClick={() => setShop(null)}>
                change
              </button>
            </span>
          ) : (
            <>
              <input className={inputClass} value={shopQuery} onChange={(e) => findShops(e.target.value)} placeholder="Name or pincode" />
              {shops.length ? (
                <ul className="mt-1 max-h-40 overflow-auto rounded border border-cream-200 bg-white">
                  {shops.map((s) => (
                    <li key={s.id}>
                      <button type="button" className="w-full px-2 py-1 text-left hover:bg-cream-100" onClick={() => (setShop(s), setShops([]))}>
                        {s.name} · {s.pincode}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </label>
        <label className="text-sm sm:col-span-2">
          Notes
          <textarea className={inputClass} rows={2} value={form.notes} onChange={set("notes")} maxLength={2000} />
        </label>
      </div>
      {note}
      <div className="flex gap-2">
        <Button
          disabled={busy || !form.assigneeUserId || form.title.trim().length < 3}
          onClick={async () => {
            const ok = await run(
              () =>
                send("/api/staff/operations/tasks", "POST", {
                  kind: form.kind,
                  title: form.title,
                  notes: form.notes || null,
                  priority: form.priority,
                  assigneeUserId: form.assigneeUserId,
                  zoneId: form.zoneId || null,
                  shopId: shop?.id ?? null,
                  dueAt: fromLocal(form.dueAt),
                }),
              "Task assigned. The assignee has been notified.",
            );
            if (ok) {
              setForm({ ...form, title: "", notes: "", dueAt: "" });
              setShop(null);
            }
          }}
        >
          Assign task
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </Card>
  );
}

export function TaskActions({
  taskId,
  status,
  isManager,
  isAssignee,
  people,
  assigneeUserId,
  shopId,
  supportEnabled,
}: {
  taskId: string;
  status: string;
  isManager: boolean;
  isAssignee: boolean;
  people: PersonOption[];
  assigneeUserId: string;
  shopId: string | null;
  supportEnabled: boolean;
}) {
  const { busy, run, note } = useAction();
  const [text, setText] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [to, setTo] = useState("");
  const active = status === "OPEN" || status === "IN_PROGRESS";
  const canWork = isAssignee || isManager;
  const patch = (body: Record<string, unknown>, ok: string) =>
    run(() => send(`/api/staff/operations/tasks/${taskId}`, "PATCH", body), ok).then((done) => done && setText(""));

  return (
    <Card className="grid gap-2 p-3">
      <label className="text-sm">
        Note / outcome / reason
        <textarea className={inputClass} rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
      </label>
      <div className="flex flex-wrap gap-2">
        {canWork && status === "OPEN" ? (
          <Button size="sm" disabled={busy} onClick={() => patch({ action: "START", note: text || null }, "Started.")}>
            Start
          </Button>
        ) : null}
        {canWork ? (
          <Button size="sm" variant="secondary" disabled={busy || !text.trim()} onClick={() => patch({ action: "NOTE", note: text }, "Note added.")}>
            Add note
          </Button>
        ) : null}
        {canWork && active ? (
          <Button size="sm" disabled={busy || !text.trim()} onClick={() => patch({ action: "DONE", outcome: text }, "Marked done.")}>
            Done
          </Button>
        ) : null}
        {isManager && active ? (
          <Button size="sm" variant="danger" disabled={busy || !text.trim()} onClick={() => patch({ action: "CANCEL", note: text }, "Cancelled.")}>
            Cancel task
          </Button>
        ) : null}
        {isManager && !active ? (
          <Button size="sm" variant="secondary" disabled={busy || !text.trim()} onClick={() => patch({ action: "REOPEN", note: text }, "Reopened.")}>
            Reopen
          </Button>
        ) : null}
      </div>
      {canWork && active ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            Follow up on (IST)
            <input type="datetime-local" className={inputClass} value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !followUp}
            onClick={() => patch({ action: "FOLLOW_UP", followUpAt: fromLocal(followUp), note: text || null }, "Follow-up set.")}
          >
            Set follow-up
          </Button>
        </div>
      ) : null}
      {isManager && active ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            Reassign to
            <select className={inputClass} value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose…</option>
              {people
                .filter((p) => p.id !== assigneeUserId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !to}
            onClick={() => run(() => send(`/api/staff/operations/tasks/${taskId}`, "POST", { assigneeUserId: to, note: text || null }), "Reassigned.")}
          >
            Reassign
          </Button>
        </div>
      ) : null}
      {supportEnabled && shopId && canWork ? (
        <Link
          className="text-sm font-semibold text-kesari-800 hover:underline"
          href={`/support?new=1&shopId=${encodeURIComponent(shopId)}&opsTaskId=${encodeURIComponent(taskId)}`}
        >
          Raise a support ticket for this shop →
        </Link>
      ) : null}
      {note}
    </Card>
  );
}

/* ------------------------------------------------------------- zones */

export function ZoneAssigner({ userId, zones }: { userId: string; zones: { zoneId: string; name: string }[] }) {
  const { busy, run, note } = useAction();
  const [zoneId, setZoneId] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={`${inputClass} max-w-56`} value={zoneId} onChange={(e) => setZoneId(e.target.value)} aria-label="Zone to add">
        <option value="">Add a zone…</option>
        {zones.map((z) => (
          <option key={z.zoneId} value={z.zoneId}>
            {z.name}
          </option>
        ))}
      </select>
      <Button size="sm" variant="secondary" disabled={busy || !zoneId} onClick={() => run(() => send("/api/staff/operations/team", "POST", { userId, zoneId }), "Zone added.")}>
        Add
      </Button>
      {note}
    </div>
  );
}

export function EndZoneButton({ assignmentId, label }: { assignmentId: string; label: string }) {
  const { busy, run, note } = useAction();
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone="info">{label}</Badge>
      <button
        type="button"
        className="min-h-8 px-1 text-xs text-red-700 underline disabled:opacity-50"
        disabled={busy}
        aria-label={`Remove zone ${label}`}
        onClick={() => run(() => send(`/api/staff/operations/team?assignmentId=${assignmentId}`, "DELETE"), "Zone removed.")}
      >
        remove
      </button>
      {note}
    </span>
  );
}

/* --------------------------------------------------------- customers */

export function AssistForm() {
  const { busy, run, note } = useAction();
  const blank = { customerName: "", contactEmail: "", contactPhone: "", pincode: "", notes: "" };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Card className="grid gap-2 p-3">
      <h2 className="font-semibold">Help a customer register</h2>
      <p className="text-sm text-ink-600">
        Record the customer, then help them open GoKesari on their own phone and sign in with the code e-mailed to them. Once they do, this entry
        shows them as registered.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={inputClass} placeholder="Customer name" value={f.customerName} onChange={set("customerName")} maxLength={120} />
        <input className={inputClass} placeholder="E-mail" type="email" value={f.contactEmail} onChange={set("contactEmail")} maxLength={200} />
        <input className={inputClass} placeholder="Mobile (10 digits)" inputMode="tel" value={f.contactPhone} onChange={set("contactPhone")} maxLength={20} />
        <input className={inputClass} placeholder="Pincode" inputMode="numeric" value={f.pincode} onChange={set("pincode")} maxLength={6} />
        <textarea className={`${inputClass} sm:col-span-2`} rows={2} placeholder="Notes (what they asked about)" value={f.notes} onChange={set("notes")} maxLength={2000} />
      </div>
      {note}
      <div>
        <Button
          disabled={busy || f.customerName.trim().length < 2 || (!f.contactEmail.trim() && !f.contactPhone.trim())}
          onClick={async () => {
            const ok = await run(
              () =>
                send("/api/staff/operations/customers", "POST", {
                  customerName: f.customerName,
                  contactEmail: f.contactEmail || null,
                  contactPhone: f.contactPhone || null,
                  pincode: f.pincode || null,
                  notes: f.notes || null,
                }),
              "Saved.",
            );
            if (ok) setF(blank);
          }}
        >
          Save
        </Button>
      </div>
    </Card>
  );
}

export function AssistStatusButtons({ id, status }: { id: string; status: string }) {
  const { busy, run, note } = useAction();
  if (status !== "ENQUIRY" && status !== "INVITED") return null;
  const to = (s: string, ok: string) => run(() => send(`/api/staff/operations/customers?id=${id}`, "PATCH", { status: s }), ok);
  return (
    <span className="inline-flex flex-wrap gap-1">
      {status === "ENQUIRY" ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => to("INVITED", "Marked as helped to sign in.")}>
          Helped to sign in
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => to("DROPPED", "Marked as not interested.")}>
        Not interested
      </Button>
      {note}
    </span>
  );
}
