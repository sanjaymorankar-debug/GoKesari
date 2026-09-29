"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, Money, inputClass } from "@/components/ui";

/** Shared request helper for the Phase 3 controls. */
function useSend() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function send(url: string, method: string, body: unknown, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setNotice(success);
      router.refresh();
      return payload;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, notice, send };
}

function Messages({ error, notice }: { error: string | null; notice: string | null }) {
  if (error) {
    return (
      <div className="mt-2">
        <Alert tone="danger">{error}</Alert>
      </div>
    );
  }
  return notice ? <p className="mt-2 text-xs text-leaf-700">{notice}</p> : null;
}

const ROLE_LABEL: Record<string, string> = {
  CUSTOMER: "Customer",
  SHOP_OWNER: "Shop owner",
  OPERATOR: "Operator",
  ADMIN: "Admin",
  DELIVERY_PARTNER: "Delivery partner",
  SOCIETY_ADMIN: "Society admin",
};

const ROLE_HOME: Record<string, string> = {
  CUSTOMER: "/",
  SHOP_OWNER: "/shop",
  OPERATOR: "/admin",
  ADMIN: "/admin",
  DELIVERY_PARTNER: "/delivery-partner",
  SOCIETY_ADMIN: "/society",
};

/* ================================================== GS-003 role switcher */

/** Header control to switch the active role; shown only to users holding more than one. */
export function RoleSwitcher({ active, roles }: { active: string; roles: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (roles.length < 2) return null;

  async function change(role: string) {
    setBusy(true);
    const response = await fetch("/api/me/roles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    setBusy(false);
    if (response.ok) {
      router.push(ROLE_HOME[role] ?? "/");
      router.refresh();
    }
  }

  return (
    <select
      aria-label="Acting as"
      title="Acting as"
      className="rounded-lg border border-cream-200 bg-white px-2 py-1.5 text-xs font-medium text-ink-700"
      value={active}
      disabled={busy}
      onChange={(e) => change(e.target.value)}
      data-testid="role-switcher"
    >
      {roles.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABEL[role] ?? role}
        </option>
      ))}
    </select>
  );
}

/** Admin: revoke one of a user's extra roles (GS-003). */
export function RevokeRoleButton({ userId, role }: { userId: string; role: string }) {
  const { busy, error, notice, send } = useSend();
  return (
    <span>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => send(`/api/users/${userId}/roles?role=${role}`, "DELETE", undefined, "Role removed.")}
      >
        Remove {ROLE_LABEL[role] ?? role}
      </Button>
      <Messages error={error} notice={notice} />
    </span>
  );
}

/* ============================================================ GS-030 COD */

export function CodSettingToggle({ shopId, enabled, maxOrderPaise }: { shopId: string; enabled: boolean; maxOrderPaise: number }) {
  const { busy, error, notice, send } = useSend();
  return (
    <div>
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) =>
            send(`/api/shops/${shopId}`, "PATCH", { codEnabled: e.target.checked }, e.target.checked ? "Cash on delivery turned on." : "Cash on delivery turned off.")
          }
          data-testid="cod-toggle"
        />
        Accept cash on delivery
      </label>
      <p className="mt-1 text-xs text-ink-500">
        Up to <Money paise={maxOrderPaise} /> per order. The rider collects the cash (or you, when you deliver
        yourself); cash you hold is deducted from your next settlement unless you deposit it.
      </p>
      <Messages error={error} notice={notice} />
    </div>
  );
}

export function CodDepositForm({ party, id, heldPaise }: { party: "RIDER" | "SHOP"; id: string; heldPaise: number }) {
  const { busy, error, notice, send } = useSend();
  const [amount, setAmount] = useState((heldPaise / 100).toFixed(2));
  const [reference, setReference] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const paise = Math.round(Number(amount) * 100);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Amount (₹)">
        <input className={`${inputClass} w-28`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Receipt / reference">
        <input className={`${inputClass} w-44`} value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <Button
        size="sm"
        disabled={busy || !(paise > 0) || paise > heldPaise || reference.trim().length < 3}
        onClick={async () => {
          const result = await send("/api/admin/cod", "POST", { party, id, amountPaise: paise, reference, requestId }, "Deposit recorded.");
          if (result) setRequestId(crypto.randomUUID());
        }}
      >
        Record deposit
      </Button>
      <Messages error={error} notice={notice} />
    </div>
  );
}

/* ================================================ GS-052 segments */

interface RulesForm {
  pincodes: string;
  minOrders: string;
  orderedWithinDays: string;
  lapsedForDays: string;
  minSpendRupees: string;
}

function toRules(form: RulesForm) {
  const int = (v: string) => (v.trim() ? Number(v) : undefined);
  return {
    ...(form.pincodes.trim() ? { pincodes: form.pincodes.split(/[\s,]+/).filter(Boolean) } : {}),
    ...(int(form.minOrders) ? { minOrders: int(form.minOrders) } : {}),
    ...(int(form.orderedWithinDays) ? { orderedWithinDays: int(form.orderedWithinDays) } : {}),
    ...(int(form.lapsedForDays) ? { lapsedForDays: int(form.lapsedForDays) } : {}),
    ...(form.minSpendRupees.trim() ? { minSpendPaise: Math.round(Number(form.minSpendRupees) * 100) } : {}),
  };
}

/** Build a segment from the shop's own customers and preview its size (counts only). */
export function SegmentBuilder({ shopId }: { shopId: string }) {
  const { busy, error, notice, send } = useSend();
  const [name, setName] = useState("");
  const [form, setForm] = useState<RulesForm>({ pincodes: "", minOrders: "", orderedWithinDays: "", lapsedForDays: "", minSpendRupees: "" });
  const [preview, setPreview] = useState<{ matched: number; reachable: number } | null>(null);
  const set = (key: keyof RulesForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [key]: e.target.value });
    setPreview(null);
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Segment name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Regulars near the shop" />
        </Field>
        <Field label="Delivery PIN codes (optional)">
          <input className={inputClass} value={form.pincodes} onChange={set("pincodes")} placeholder="411001, 411002" />
        </Field>
        <Field label="At least this many delivered orders">
          <input className={inputClass} inputMode="numeric" value={form.minOrders} onChange={set("minOrders")} />
        </Field>
        <Field label="Ordered within the last (days)">
          <input className={inputClass} inputMode="numeric" value={form.orderedWithinDays} onChange={set("orderedWithinDays")} />
        </Field>
        <Field label="Has not ordered for (days)">
          <input className={inputClass} inputMode="numeric" value={form.lapsedForDays} onChange={set("lapsedForDays")} placeholder="lapsed customers" />
        </Field>
        <Field label="Spent at least (₹)">
          <input className={inputClass} inputMode="decimal" value={form.minSpendRupees} onChange={set("minSpendRupees")} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            const result = await send(`/api/shops/${shopId}/marketing/segments`, "POST", { preview: true, rules: toRules(form) }, "");
            if (result) setPreview(result);
          }}
        >
          Preview audience
        </Button>
        <Button
          size="sm"
          disabled={busy || name.trim().length < 2}
          onClick={async () => {
            const result = await send(`/api/shops/${shopId}/marketing/segments`, "POST", { name, rules: toRules(form) }, "Segment saved.");
            if (result) {
              setName("");
              setPreview(null);
            }
          }}
        >
          Save segment
        </Button>
        {preview ? (
          <span className="text-sm text-ink-600" data-testid="segment-preview">
            {preview.matched} customers match · {preview.reachable} agreed to offers
          </span>
        ) : null}
      </div>
      <Messages error={error} notice={notice} />
    </div>
  );
}

export function DeleteSegmentButton({ shopId, segmentId }: { shopId: string; segmentId: string }) {
  const { busy, error, notice, send } = useSend();
  return (
    <span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => send(`/api/shops/${shopId}/marketing/segments/${segmentId}`, "DELETE", undefined, "Deleted.")}>
        Delete
      </Button>
      <Messages error={error} notice={notice} />
    </span>
  );
}

/* ============================================ GS-053 / WF-009 campaigns */

export function CampaignForm({ shopId, segments }: { shopId: string; segments: { id: string; name: string; reachable: number }[] }) {
  const { busy, error, notice, send } = useSend();
  const [form, setForm] = useState({ segmentId: segments[0]?.id ?? "", title: "", message: "", offerText: "", maxRecipients: "200", attributionDays: "7" });
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm({ ...form, [key]: e.target.value });

  if (segments.length === 0) return <p className="text-sm text-ink-500">Create a segment first.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Send to">
        <select className={inputClass} value={form.segmentId} onChange={set("segmentId")}>
          {segments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.reachable} reachable)
            </option>
          ))}
        </select>
      </Field>
      <Field label="Title">
        <input className={inputClass} maxLength={80} value={form.title} onChange={set("title")} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Message">
          <textarea className={inputClass} rows={3} maxLength={500} value={form.message} onChange={set("message")} />
        </Field>
      </div>
      <Field label="Offer line (optional)">
        <input className={inputClass} maxLength={120} value={form.offerText} onChange={set("offerText")} placeholder="e.g. 10% off vegetables this week" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Budget (max customers)">
          <input className={inputClass} inputMode="numeric" value={form.maxRecipients} onChange={set("maxRecipients")} />
        </Field>
        <Field label="Count orders within (days)">
          <input className={inputClass} inputMode="numeric" value={form.attributionDays} onChange={set("attributionDays")} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Button
          disabled={busy || form.title.trim().length < 3 || form.message.trim().length < 10}
          onClick={async () => {
            const result = await send(
              `/api/shops/${shopId}/marketing/campaigns`,
              "POST",
              {
                segmentId: form.segmentId,
                title: form.title,
                message: form.message,
                offerText: form.offerText || null,
                maxRecipients: Number(form.maxRecipients),
                attributionDays: Number(form.attributionDays),
              },
              "Draft saved — submit it for approval.",
            );
            if (result) setForm({ ...form, title: "", message: "", offerText: "" });
          }}
        >
          Save draft
        </Button>
        <Messages error={error} notice={notice} />
      </div>
    </div>
  );
}

export function CampaignActions({ shopId, campaignId, status }: { shopId: string; campaignId: string; status: string }) {
  const { busy, error, notice, send } = useSend();
  const act = (action: string, success: string) => send(`/api/shops/${shopId}/marketing/campaigns/${campaignId}`, "PATCH", { action }, success);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {status === "DRAFT" || status === "REJECTED" ? (
        <Button size="sm" disabled={busy} onClick={() => act("submit", "Submitted for approval.")}>
          Submit for approval
        </Button>
      ) : null}
      {status === "APPROVED" ? (
        <Button size="sm" disabled={busy} onClick={() => act("send", "Campaign sent.")}>
          Send now
        </Button>
      ) : null}
      {["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"].includes(status) ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("cancel", "Cancelled.")}>
          Cancel
        </Button>
      ) : null}
      <Messages error={error} notice={notice} />
    </span>
  );
}

export function CampaignDecisionButtons({ campaignId }: { campaignId: string }) {
  const { busy, error, notice, send } = useSend();
  const [reason, setReason] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => send(`/api/admin/campaigns/${campaignId}/decision`, "POST", { decision: "approve" }, "Approved.")}>
        Approve
      </Button>
      <input className={`${inputClass} w-56`} placeholder="Reason to reject" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button
        size="sm"
        variant="secondary"
        disabled={busy || reason.trim().length < 3}
        onClick={() => send(`/api/admin/campaigns/${campaignId}/decision`, "POST", { decision: "reject", reason }, "Rejected.")}
      >
        Reject
      </Button>
      <Messages error={error} notice={notice} />
    </div>
  );
}

/* ================================================== GS-068 risk review */

export function RunRiskRulesButton() {
  const { busy, error, notice, send } = useSend();
  return (
    <div>
      <Button size="sm" disabled={busy} onClick={() => send("/api/admin/risk", "POST", undefined, "Rules run — queue refreshed.")}>
        Run rules now
      </Button>
      <Messages error={error} notice={notice} />
    </div>
  );
}

export function RiskReviewButtons({ flagId }: { flagId: string }) {
  const { busy, error, notice, send } = useSend();
  const [note, setNote] = useState("");
  const decide = (decision: "DISMISSED" | "ACTIONED") => send(`/api/admin/risk/${flagId}`, "PATCH", { decision, note }, "Reviewed.");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input className={`${inputClass} w-64`} placeholder="What you checked / did" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button size="sm" disabled={busy || note.trim().length < 5} onClick={() => decide("ACTIONED")}>
        Actioned
      </Button>
      <Button size="sm" variant="secondary" disabled={busy || note.trim().length < 5} onClick={() => decide("DISMISSED")}>
        Dismiss
      </Button>
      <Messages error={error} notice={notice} />
    </div>
  );
}

type RiskSuspendSubject = "USER" | "SHOP" | "DELIVERY_PARTNER";

const SUSPEND_COPY: Record<RiskSuspendSubject, { noun: string; effect: string }> = {
  USER: {
    noun: "account",
    effect: "Signs them out and blocks sign-in. There is no reinstate action in the app yet.",
  },
  SHOP: {
    noun: "shop",
    effect: "Hides the shop and stops new orders. Open orders are not cancelled.",
  },
  DELIVERY_PARTNER: {
    noun: "delivery partner",
    effect: "Stops new delivery offers and notifies the rider. Reactivate from the delivery partner queue.",
  },
};

function suspendRequest(subjectType: RiskSuspendSubject, subjectId: string, reason: string) {
  if (subjectType === "DELIVERY_PARTNER") {
    return { url: `/api/delivery-partner/${subjectId}`, method: "PATCH", body: { action: "suspend", reason } };
  }
  if (subjectType === "SHOP") return { url: `/api/shops/${subjectId}/suspend`, method: "POST", body: { reason } };
  return { url: `/api/users/${subjectId}/suspend`, method: "POST", body: { reason } };
}

async function requestError(url: string, method: string, body: unknown): Promise<string | null> {
  try {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.ok) return null;
    const payload = await response.json().catch(() => null);
    return payload?.error?.message ?? "That did not work.";
  } catch {
    return "Could not reach the server.";
  }
}

/** Suspends the flag's subject through its existing endpoint, then closes the flag as ACTIONED. */
export function RiskSuspendButton({
  flagId,
  subjectType,
  subjectId,
  available,
}: {
  flagId: string;
  subjectType: RiskSuspendSubject;
  subjectId: string;
  available: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { noun, effect } = SUSPEND_COPY[subjectType];

  async function suspendAndClose() {
    const trimmed = reason.trim();
    setBusy(true);
    setError(null);
    setNotice(null);
    const suspend = suspendRequest(subjectType, subjectId, trimmed);
    const suspendError = await requestError(suspend.url, suspend.method, suspend.body);
    if (suspendError) {
      setBusy(false);
      setError(`The ${noun} was not suspended: ${suspendError}`);
      return;
    }
    setSuspended(true);
    const flagError = await requestError(`/api/admin/risk/${flagId}`, "PATCH", { decision: "ACTIONED", note: `Suspended: ${trimmed}` });
    setBusy(false);
    setOpen(false);
    setReason("");
    if (flagError) {
      setError(`The ${noun} WAS suspended, but this flag could not be marked actioned (${flagError}). Close it above with a note.`);
    } else {
      setNotice(`The ${noun} was suspended and the flag marked actioned.`);
    }
    router.refresh();
  }

  const canSuspend = available && !suspended;
  if (!canSuspend && !error && !notice) return null;
  return (
    <div>
      {canSuspend ? (
        open ? (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={`${inputClass} w-64`}
                maxLength={480}
                aria-label={`Reason for suspending this ${noun}`}
                placeholder={`Why suspend this ${noun}?`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button size="sm" variant="danger" disabled={busy || reason.trim().length < 5} onClick={suspendAndClose}>
                Confirm suspension
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
            <p className="text-xs text-ink-500">{effect}</p>
          </div>
        ) : (
          <Button size="sm" variant="danger" onClick={() => setOpen(true)} data-testid="risk-suspend">
            Suspend &amp; mark actioned
          </Button>
        )
      ) : null}
      <Messages error={error} notice={notice} />
    </div>
  );
}
