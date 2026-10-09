"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Field, inputClass } from "@/components/ui";

export interface DeliveryStaffRow {
  id: string;
  name: string;
  phoneE164: string;
  isActive: boolean;
}

/**
 * The shop's own delivery people (docs/four-features-2026-10, feature 1):
 * add, edit, deactivate / reactivate. Only name and mobile are kept.
 */
export function DeliveryStaffManager({ shopId, staff }: { shopId: string; staff: DeliveryStaffRow[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function send(url: string, method: string, body: unknown, fallback: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? fallback);
      router.refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink-900">Add a delivery person</h2>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await send(`/api/shops/${shopId}/delivery-staff`, "POST", { name, mobile }, "Could not add them.")) {
              setNotice(`${name.trim()} added.`);
              setName("");
              setMobile("");
            }
          }}
        >
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} />
          </Field>
          <Field label="Mobile number">
            <input
              className={inputClass}
              value={mobile}
              onChange={(e) => setMobile(e.target.value.replace(/[^\d]/g, "").slice(0, 10))}
              inputMode="numeric"
              placeholder="10-digit mobile"
              required
            />
          </Field>
          <Button type="submit" disabled={busy || name.trim().length < 2 || mobile.length !== 10}>
            Add
          </Button>
        </form>
        {error ? (
          <div className="mt-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}
        {notice ? <p className="mt-2 text-sm text-leaf-700">{notice}</p> : null}
      </Card>

      {staff.length === 0 ? (
        <EmptyState title="No delivery people yet" description="Add the people who deliver for your shop. You choose one when you mark an order ready for your own delivery." />
      ) : (
        <Card className="divide-y divide-cream-100">
          {staff.map((member) => (
            <StaffRow key={member.id} member={member} busy={busy} onSave={(patch) => send(`/api/shops/${shopId}/delivery-staff/${member.id}`, "PATCH", patch, "Could not save.")} />
          ))}
        </Card>
      )}
    </div>
  );
}

function StaffRow({
  member,
  busy,
  onSave,
}: {
  member: DeliveryStaffRow;
  busy: boolean;
  onSave: (patch: { name?: string; mobile?: string; isActive?: boolean }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);
  const [mobile, setMobile] = useState(member.phoneE164.replace(/^\+91/, ""));

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="delivery-staff-row">
      {editing ? (
        <form
          className="grid w-full gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onSave({ name, mobile })) setEditing(false);
          }}
        >
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <input
            className={inputClass}
            value={mobile}
            onChange={(e) => setMobile(e.target.value.replace(/[^\d]/g, "").slice(0, 10))}
            inputMode="numeric"
            aria-label="Mobile number"
          />
          <Button size="sm" type="submit" disabled={busy}>
            Save
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <>
          <div>
            <p className="font-medium text-ink-900">
              {member.name} {member.isActive ? null : <Badge tone="warning">deactivated</Badge>}
            </p>
            <p className="text-sm text-ink-500">{member.phoneE164.replace(/^\+91/, "+91 ")}</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant={member.isActive ? "ghost" : "secondary"}
              disabled={busy}
              onClick={() => void onSave({ isActive: !member.isActive })}
            >
              {member.isActive ? "Deactivate" : "Reactivate"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
