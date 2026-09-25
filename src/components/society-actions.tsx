"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";

/** Shared request helper for society controls. */
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
        body: JSON.stringify(body),
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

/** Register a new society (the registrant becomes its first admin; operations verify it). */
export function RegisterSocietyForm() {
  const { busy, error, notice, send } = useSend();
  const [form, setForm] = useState({ name: "", addressLine1: "", area: "", city: "", pincode: "", unitLabel: "" });
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Society name">
        <input className={inputClass} value={form.name} onChange={set("name")} />
      </Field>
      <Field label="Your flat / unit">
        <input className={inputClass} value={form.unitLabel} onChange={set("unitLabel")} placeholder="e.g. B-1204" />
      </Field>
      <Field label="Address">
        <input className={inputClass} value={form.addressLine1} onChange={set("addressLine1")} />
      </Field>
      <Field label="Area">
        <input className={inputClass} value={form.area} onChange={set("area")} />
      </Field>
      <Field label="City">
        <input className={inputClass} value={form.city} onChange={set("city")} />
      </Field>
      <Field label="PIN code">
        <input className={inputClass} inputMode="numeric" maxLength={6} value={form.pincode} onChange={set("pincode")} />
      </Field>
      <div className="sm:col-span-2">
        <Button
          disabled={busy || form.name.trim().length < 3 || !/^\d{6}$/.test(form.pincode)}
          onClick={() =>
            send(
              "/api/societies",
              "POST",
              { ...form, area: form.area || null, unitLabel: form.unitLabel || null },
              "Registered — our team will verify the society shortly.",
            )
          }
        >
          Register society
        </Button>
        <Messages error={error} notice={notice} />
      </div>
    </div>
  );
}

/** Search verified societies and ask to join one. */
export function JoinSocietyForm() {
  const { busy, error, notice, send } = useSend();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; area: string | null; city: string; pincode: string }[]>([]);
  const [unit, setUnit] = useState("");
  const [searched, setSearched] = useState(false);

  async function search() {
    const response = await fetch(`/api/societies?q=${encodeURIComponent(query)}`);
    const payload = await response.json().catch(() => []);
    setResults(Array.isArray(payload) ? payload : []);
    setSearched(true);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <input
          className={`${inputClass} max-w-xs`}
          placeholder="Society name, area or PIN"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search societies"
        />
        <input
          className={`${inputClass} w-32`}
          placeholder="Your flat"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          aria-label="Your flat or unit"
        />
        <Button variant="secondary" onClick={search}>
          Search
        </Button>
      </div>
      {searched && results.length === 0 ? <p className="mt-2 text-sm text-ink-500">No verified society found.</p> : null}
      <ul className="mt-3 divide-y divide-cream-100 text-sm">
        {results.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              {s.name} <span className="text-xs text-ink-500">· {[s.area, s.city].filter(Boolean).join(", ")} {s.pincode}</span>
            </span>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => send(`/api/societies/${s.id}/members`, "POST", { unitLabel: unit || null }, "Request sent to the society.")}
            >
              Ask to join
            </Button>
          </li>
        ))}
      </ul>
      <Messages error={error} notice={notice} />
    </div>
  );
}

/** Society rules and instructions (society ADMIN). */
export function SocietySettingsForm({
  societyId,
  initial,
}: {
  societyId: string;
  initial: { deliveryInstructions: string | null; securityNotifyEnabled: boolean; exclusiveRiders: boolean; boundaryRadiusMeters: number };
}) {
  const { busy, error, notice, send } = useSend();
  const [instructions, setInstructions] = useState(initial.deliveryInstructions ?? "");
  const [security, setSecurity] = useState(initial.securityNotifyEnabled);
  const [exclusive, setExclusive] = useState(initial.exclusiveRiders);
  const [radius, setRadius] = useState(String(initial.boundaryRadiusMeters));

  return (
    <div className="space-y-3">
      <Field label="Gate / parking / access instructions for riders">
        <textarea className={inputClass} rows={2} maxLength={500} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={security} onChange={(e) => setSecurity(e.target.checked)} />
        Notify society staff (security) when a rider is assigned to a delivery here
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} />
        Only riders on our list may deliver here (applies once the list has riders)
      </label>
      <Field label="Society boundary (metres from its pin)">
        <input className={`${inputClass} w-32`} type="number" min={50} max={3000} value={radius} onChange={(e) => setRadius(e.target.value)} />
      </Field>
      <Button
        disabled={busy}
        onClick={() =>
          send(
            `/api/societies/${societyId}`,
            "PATCH",
            {
              deliveryInstructions: instructions || null,
              securityNotifyEnabled: security,
              exclusiveRiders: exclusive,
              boundaryRadiusMeters: Number(radius),
            },
            "Saved.",
          )
        }
      >
        Save rules
      </Button>
      <Messages error={error} notice={notice} />
    </div>
  );
}

/** Approve / decline / change role / remove a member. */
export function MemberActions({
  memberId,
  status,
  role,
  canSetRole,
}: {
  memberId: string;
  status: string;
  role: string;
  canSetRole: boolean;
}) {
  const { busy, error, send } = useSend();
  const act = (body: Record<string, unknown>, msg: string) => send(`/api/societies/members/${memberId}`, "PATCH", body, msg);
  return (
    <span className="flex flex-wrap items-center gap-2">
      {status === "PENDING" ? (
        <>
          <Button size="sm" disabled={busy} onClick={() => act({ action: "approve" }, "Approved")}>
            Approve
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "decline" }, "Declined")}>
            Decline
          </Button>
        </>
      ) : null}
      {status === "ACTIVE" && canSetRole ? (
        <select
          className="rounded-lg border border-cream-200 px-2 py-1 text-xs"
          value={role}
          disabled={busy}
          onChange={(e) => act({ action: "role", role: e.target.value }, "Role updated")}
          aria-label="Society role"
        >
          <option value="RESIDENT">Resident</option>
          <option value="OPERATOR">Operator</option>
          <option value="ADMIN">Admin</option>
        </select>
      ) : null}
      {status === "ACTIVE" ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "remove" }, "Removed")}>
          Remove
        </Button>
      ) : null}
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

/** Add a rider to the society list by their registered mobile. */
export function AddRiderForm({ societyId }: { societyId: string }) {
  const { busy, error, notice, send } = useSend();
  const [mobile, setMobile] = useState("");
  const [preferred, setPreferred] = useState(false);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputClass} w-44`}
          inputMode="numeric"
          placeholder="Rider's mobile"
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
          aria-label="Rider mobile number"
        />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={preferred} onChange={(e) => setPreferred(e.target.checked)} /> Preferred
        </label>
        <Button
          size="sm"
          disabled={busy || mobile.replace(/\D/g, "").length < 10}
          onClick={async () => {
            const ok = await send(`/api/societies/${societyId}/riders`, "POST", { mobile, preferred }, "Rider added — effective immediately.");
            if (ok) setMobile("");
          }}
        >
          Add rider
        </Button>
      </div>
      <Messages error={error} notice={notice} />
    </div>
  );
}

export function RiderLinkActions({ linkId, status, preferred }: { linkId: string; status: string; preferred: boolean }) {
  const { busy, error, send } = useSend();
  if (status !== "ACTIVE") return <span className="text-xs text-ink-400">revoked</span>;
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => send(`/api/societies/riders/${linkId}`, "PATCH", { preferred: !preferred }, "Updated")}
      >
        {preferred ? "Unmark preferred" : "Mark preferred"}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => send(`/api/societies/riders/${linkId}`, "PATCH", { revoke: true }, "Revoked")}>
        Revoke
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

/** Add a nearby approved shop to the society's list, or remove one. */
export function SocietyShopToggle({ societyId, shopId, active, label }: { societyId: string; shopId: string; active: boolean; label: string }) {
  const { busy, error, send } = useSend();
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant={active ? "ghost" : "secondary"}
        disabled={busy}
        onClick={() => send(`/api/societies/${societyId}/shops`, "POST", { shopId, active: !active }, active ? "Removed" : "Added")}
      >
        {active ? "Remove" : label}
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

/** Operations: verify / reject / suspend / reinstate a society. */
export function SocietyDecisionButtons({ societyId, status }: { societyId: string; status: string }) {
  const { busy, error, send } = useSend();
  const [reason, setReason] = useState("");
  const decide = (decision: string) => send(`/api/societies/${societyId}/decision`, "POST", { decision, reason: reason || undefined }, "Done");
  return (
    <span className="flex flex-wrap items-center gap-2">
      {status === "APPLIED" || status === "VERIFIED" ? (
        <input
          className="w-40 rounded-lg border border-cream-200 px-2 py-1 text-xs"
          placeholder="Reason (reject/suspend)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Reason"
        />
      ) : null}
      {status === "APPLIED" ? (
        <>
          <Button size="sm" disabled={busy} onClick={() => decide("verify")}>
            Verify
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || reason.trim().length < 3} onClick={() => decide("reject")}>
            Reject
          </Button>
        </>
      ) : null}
      {status === "VERIFIED" ? (
        <Button size="sm" variant="ghost" disabled={busy || reason.trim().length < 3} onClick={() => decide("suspend")}>
          Suspend
        </Button>
      ) : null}
      {status === "SUSPENDED" ? (
        <Button size="sm" disabled={busy} onClick={() => decide("reinstate")}>
          Reinstate
        </Button>
      ) : null}
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

/** Link one of your addresses to a society you belong to (or clear it). */
export function AddressSocietySelect({
  addressId,
  current,
  options,
}: {
  addressId: string;
  current: string | null;
  options: { id: string; name: string }[];
}) {
  const { busy, error, send } = useSend();
  if (options.length === 0 && !current) return null;
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-ink-500">Society:</span>
      <select
        className="rounded-lg border border-cream-200 px-2 py-1 text-xs"
        value={current ?? ""}
        disabled={busy}
        onChange={(e) => send(`/api/addresses/${addressId}/society`, "PUT", { societyId: e.target.value || null }, "Saved")}
        aria-label="Society for this address"
      >
        <option value="">Not in a society</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {error ? <span className="text-red-600">{error}</span> : null}
    </span>
  );
}
