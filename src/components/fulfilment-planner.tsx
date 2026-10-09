"use client";

import { useState, useSyncExternalStore } from "react";

import { Alert, Badge, Button } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import {
  FULFILMENT_OPTION_HINTS,
  FULFILMENT_OPTION_KEYS,
  FULFILMENT_OPTION_LABELS,
  type FulfilmentOptionKey,
  type SlotDay,
} from "@/lib/fulfilment-options";

/** What the shop's order card knows about an order's plan (services/fulfilment-options.ts ShopFulfilmentView). */
export interface PlannerPlan {
  option: FulfilmentOptionKey;
  optionLabel: string;
  whenLabel: string;
  slotKey: string;
  staff: { id: string; name: string; phoneE164: string } | null;
  staffLinkPath: string | null;
  outForDelivery: boolean;
  completed: boolean;
  locked: boolean;
  riderSearchFrom: string | null;
  /** Pickup: the customer's delivery fee given back (paise). */
  deliveryFeeRefundedPaise?: number | null;
}

export interface PlannerStaff {
  id: string;
  name: string;
  phoneE164: string;
}

/**
 * Fulfilment options (docs/four-features-2026-10, feature 1) on the shop's
 * order card: choose pickup / own delivery / GoKesari partner and a time when
 * marking the order ready, change it until the order leaves, and hand it over
 * with the customer's code. The server re-checks everything.
 */
export function FulfilmentPlanner({
  orderId,
  status,
  plan,
  days,
  staff,
  hasAddress,
  shopDelivers,
  cashOnDelivery,
  pickupRefundPaise = 0,
  onChanged,
}: {
  orderId: string;
  status: string;
  plan: PlannerPlan | null;
  days: SlotDay[];
  staff: PlannerStaff[];
  hasAddress: boolean;
  shopDelivers: boolean;
  cashOnDelivery: boolean;
  /** Choosing pickup gives the customer this delivery fee back (0: nothing to give back). */
  pickupRefundPaise?: number;
  onChanged: () => void;
}) {
  const choosing = status === "PREPARING" && !plan;
  const changeable =
    plan != null &&
    !plan.completed &&
    !(plan.option === "SHOP_DELIVERY" && plan.outForDelivery) &&
    ["ACCEPTED", "PREPARING", "READY", "ASSIGNED"].includes(status);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [cash, setCash] = useState(false);

  async function post(url: string, body: unknown, fallback: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? fallback);
      setEditing(false);
      setCode("");
      onChanged();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const handover = (body: Record<string, unknown>) =>
    post(`/api/orders/${orderId}/fulfilment-plan/handover`, body, "Could not update the order.");

  const showForm = choosing || editing;

  return (
    <div className="mt-3 rounded-lg border border-cream-200 bg-cream-50 p-3 text-sm" data-testid="fulfilment-planner">
      {plan && !editing ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-ink-800" data-testid="fulfilment-plan">
            <span className="font-medium">{plan.optionLabel}</span>
            {plan.staff ? ` · ${plan.staff.name}` : ""} · {plan.whenLabel}
          </p>
          <div className="flex flex-wrap gap-2">
            {plan.completed ? <Badge tone="success">handed over</Badge> : null}
            {plan.locked ? <Badge tone="danger">on hold — wrong codes</Badge> : null}
            {changeable ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
                Change
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {plan?.deliveryFeeRefundedPaise ? (
        <p className="mt-1 text-xs text-ink-600" data-testid="pickup-fee-refunded">
          The customer&apos;s {formatPaise(plan.deliveryFeeRefundedPaise)} delivery fee was given back for pickup.
        </p>
      ) : null}

      {plan?.option === "GOKESARI_PARTNER" && plan.riderSearchFrom && status === "READY" ? (
        <p className="mt-1 text-xs text-ink-600">
          The rider search starts at{" "}
          {new Date(plan.riderSearchFrom).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}
          {" "}— or press &quot;Find rider now&quot;.
        </p>
      ) : null}

      {showForm ? (
        <PlanForm
          initial={plan}
          days={days}
          staff={staff}
          hasAddress={hasAddress}
          shopDelivers={shopDelivers}
          pickupRefundPaise={plan?.deliveryFeeRefundedPaise ? 0 : pickupRefundPaise}
          busy={busy}
          submitLabel={choosing ? "Packed — mark ready" : "Save the new plan"}
          onCancel={editing ? () => setEditing(false) : undefined}
          onSubmit={(input) =>
            void post(
              `/api/orders/${orderId}/fulfilment-plan`,
              { ...input, markReady: choosing },
              choosing ? "Could not mark the order ready." : "Could not save the plan.",
            )
          }
        />
      ) : null}

      {/* Handover */}
      {plan && !editing && !plan.completed && !plan.locked ? (
        <>
          {plan.option === "PICKUP" && status === "READY" ? (
            <CodeEntry
              label="Customer's pickup code"
              buttonLabel="Customer collected"
              code={code}
              setCode={setCode}
              cash={cash}
              setCash={setCash}
              cashOnDelivery={cashOnDelivery}
              busy={busy}
              onSubmit={() => void handover({ action: "pickup", code, cashCollected: cash })}
            />
          ) : null}
          {plan.option === "SHOP_DELIVERY" && plan.staffLinkPath ? (
            <StaffLink path={plan.staffLinkPath} staff={plan.staff} onCopied={() => setNotice("Delivery link copied.")} />
          ) : null}
          {plan.option === "SHOP_DELIVERY" && status === "READY" ? (
            <div className="mt-2">
              <Button size="sm" disabled={busy} onClick={() => void handover({ action: "out_for_delivery" })}>
                Out for delivery{plan.staff ? ` with ${plan.staff.name}` : ""}
              </Button>
              <p className="mt-1 text-xs text-ink-500">The customer is emailed their delivery code when the order goes out.</p>
            </div>
          ) : null}
          {plan.option === "SHOP_DELIVERY" && status === "OUT_FOR_DELIVERY" ? (
            <CodeEntry
              label="Customer's delivery code"
              buttonLabel="Delivered"
              code={code}
              setCode={setCode}
              cash={cash}
              setCash={setCash}
              cashOnDelivery={cashOnDelivery}
              busy={busy}
              onSubmit={() => void handover({ action: "deliver", code, cashCollected: cash })}
            />
          ) : null}
        </>
      ) : null}
      {plan?.locked ? (
        <p className="mt-2 text-xs text-ink-600">Too many wrong codes: support will confirm the handover with the customer.</p>
      ) : null}

      {error ? (
        <div className="mt-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      {notice ? <p className="mt-2 text-xs text-leaf-700">{notice}</p> : null}
    </div>
  );
}

function PlanForm({
  initial,
  days,
  staff,
  hasAddress,
  shopDelivers,
  pickupRefundPaise,
  busy,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  initial: PlannerPlan | null;
  days: SlotDay[];
  staff: PlannerStaff[];
  hasAddress: boolean;
  shopDelivers: boolean;
  pickupRefundPaise: number;
  busy: boolean;
  submitLabel: string;
  onCancel?: () => void;
  onSubmit: (input: { option: FulfilmentOptionKey; slotKey: string; staffId: string | null }) => void;
}) {
  const unavailable = (option: FulfilmentOptionKey): string | null => {
    if (option === "PICKUP") return null;
    if (!hasAddress) return "No delivery address on this order.";
    if (option === "SHOP_DELIVERY" && staff.length === 0) return "Add your delivery people first (My Shop → Delivery staff).";
    if (option === "GOKESARI_PARTNER" && !shopDelivers) return "Switch on delivery in your shop settings to use GoKesari partners.";
    return null;
  };
  const firstOption = FULFILMENT_OPTION_KEYS.find((o) => !unavailable(o)) ?? "PICKUP";
  const [option, setOption] = useState<FulfilmentOptionKey>(initial?.option ?? firstOption);
  // The current slot may have started already: it stays selectable while unchanged.
  const initialDay = initial ? initial.slotKey.split("@")[0] : days[0]?.date ?? "";
  const dayList = initial && !days.some((d) => d.date === initialDay)
    ? [{ date: initialDay, label: initialDay, slots: [] }, ...days]
    : days;
  const [date, setDate] = useState(initialDay);
  const daySlots = dayList.find((d) => d.date === date)?.slots ?? [];
  const slotOptions =
    initial && date === initialDay && !daySlots.some((s) => s.key === initial.slotKey)
      ? [{ key: initial.slotKey, start: "", end: "", label: `${initial.whenLabel.split(", ")[1] ?? initial.whenLabel} (current)` }, ...daySlots]
      : daySlots;
  const [slotKey, setSlotKey] = useState(initial?.slotKey ?? daySlots[0]?.key ?? "");
  const [staffId, setStaffId] = useState(initial?.staff?.id ?? staff[0]?.id ?? "");

  const selectClass = "w-full rounded-lg border border-cream-200 bg-white px-2 py-1.5 text-sm";

  return (
    <form
      className="mt-2 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ option, slotKey, staffId: option === "SHOP_DELIVERY" ? staffId : null });
      }}
    >
      <fieldset>
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">How does it reach the customer?</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {FULFILMENT_OPTION_KEYS.map((key) => {
            const why = unavailable(key);
            return (
              <label
                key={key}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2 ${option === key ? "border-kesari-500 bg-white" : "border-cream-200 bg-white/60"} ${why ? "cursor-not-allowed opacity-60" : ""}`}
              >
                <input
                  type="radio"
                  name="fulfilment-option"
                  value={key}
                  checked={option === key}
                  disabled={Boolean(why)}
                  onChange={() => setOption(key)}
                  className="mt-0.5 accent-kesari-600"
                />
                <span>
                  <span className="block font-medium text-ink-900">{FULFILMENT_OPTION_LABELS[key]}</span>
                  <span className="block text-xs text-ink-500">{why ?? FULFILMENT_OPTION_HINTS[key]}</span>
                </span>
              </label>
            );
          })}
        </div>
        {option === "PICKUP" && pickupRefundPaise > 0 ? (
          <p className="mt-1 text-xs text-ink-600" data-testid="pickup-fee-hint">
            With pickup, the customer&apos;s {formatPaise(pickupRefundPaise)} delivery fee goes back to them.
          </p>
        ) : null}
      </fieldset>

      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-600">{option === "PICKUP" ? "Pickup date" : "Delivery date"}</span>
          <select
            className={selectClass}
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              const next = dayList.find((d) => d.date === e.target.value)?.slots[0]?.key ?? "";
              setSlotKey(next);
            }}
            aria-label="Date"
          >
            {dayList.map((d) => (
              <option key={d.date} value={d.date}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-600">Time slot</span>
          <select className={selectClass} value={slotKey} onChange={(e) => setSlotKey(e.target.value)} aria-label="Time slot">
            {slotOptions.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {option === "SHOP_DELIVERY" ? (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-600">Delivery person</span>
            <select className={selectClass} value={staffId} onChange={(e) => setStaffId(e.target.value)} aria-label="Delivery person">
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.phoneE164.replace(/^\+91/, "")})
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={busy || !slotKey || (option === "SHOP_DELIVERY" && !staffId)}>
          {busy ? "Saving…" : submitLabel}
        </Button>
        {onCancel ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function CodeEntry({
  label,
  buttonLabel,
  code,
  setCode,
  cash,
  setCash,
  cashOnDelivery,
  busy,
  onSubmit,
}: {
  label: string;
  buttonLabel: string;
  code: string;
  setCode: (v: string) => void;
  cash: boolean;
  setCash: (v: boolean) => void;
  cashOnDelivery: boolean;
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-600">{label}</span>
        <input
          className="w-28 rounded-lg border border-cream-200 bg-white px-3 py-1.5 font-mono text-base tracking-widest"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={4}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          aria-label={label}
        />
      </label>
      {cashOnDelivery ? (
        <label className="flex items-center gap-1 pb-2 text-xs text-ink-700">
          <input type="checkbox" checked={cash} onChange={(e) => setCash(e.target.checked)} className="accent-kesari-600" />
          Cash collected
        </label>
      ) : null}
      <Button size="sm" type="submit" disabled={busy || code.length !== 4 || (cashOnDelivery && !cash)}>
        {buttonLabel}
      </Button>
    </form>
  );
}

function StaffLink({
  path,
  staff,
  onCopied,
}: {
  path: string;
  staff: PlannerPlan["staff"];
  onCopied: () => void;
}) {
  // The absolute link needs the browser's origin; the server renders without it.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const url = `${origin}${path}`;
  const whatsapp = staff
    ? `https://wa.me/${staff.phoneE164.replace(/^\+/, "")}?text=${encodeURIComponent(`GoKesari delivery: ${url}`)}`
    : null;
  return (
    <div className="mt-2 rounded-lg bg-white px-3 py-2 text-xs text-ink-700" data-testid="staff-link">
      <p>
        Delivery link for {staff?.name ?? "your delivery person"} — they open it on their phone to see the address and
        enter the customer&apos;s code. Anyone with the link can do this, so share it only with them.
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(onCopied).catch(() => undefined);
          }}
        >
          Copy link
        </Button>
        {whatsapp ? (
          <a href={whatsapp} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-lg border border-cream-200 px-2.5 py-1.5 font-medium text-leaf-700 hover:bg-cream-100">
            Send on WhatsApp
          </a>
        ) : null}
        <a href={path} target="_blank" rel="noreferrer" className="inline-flex items-center px-1 py-1.5 font-medium text-kesari-700 hover:underline">
          Open
        </a>
      </div>
    </div>
  );
}
