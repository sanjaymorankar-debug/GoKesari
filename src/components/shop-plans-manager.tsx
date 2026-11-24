"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Money, inputClass } from "@/components/ui";
import { paiseToRupees, rupeesToPaise } from "@/lib/money";
import { WEEKDAY_SHORT, type SubscriptionFrequency } from "@/lib/periodicals";
import {
  PLAN_KINDS,
  PLAN_KIND_LABELS,
  PLAN_SLOTS,
  PLAN_SLOT_LABELS,
  planRulesProblem,
  serviceDaysLabel,
  slotLabel,
  type PlanKind,
  type PlanSlot,
} from "@/lib/subscription-plans";

/** A listing the shop can make a plan of. */
export interface PlanListingOption {
  shopProductId: string;
  name: string;
  unit: string;
  onlinePricePaise: number | null;
}

/** A plan as Seller Central lists it. */
export interface ManagedPlan {
  id: string;
  shopProductId: string;
  name: string;
  description: string | null;
  kind: PlanKind;
  slot: PlanSlot;
  slotWindow: string | null;
  serviceDays: number[];
  allowedFrequencies: SubscriptionFrequency[];
  pricePaise: number | null;
  termDays: number[];
  leadDays: number;
  isActive: boolean;
  productName: string;
  unit: string;
  effectivePricePaise: number | null;
  subscribers: number;
}

const FREQ_LABELS: Record<SubscriptionFrequency, string> = {
  DAILY: "Every delivery day",
  WEEKLY: "Days of the week",
  MONTHLY: "Days of the month",
};
const TERM_CHOICES = [7, 15, 30, 90];

interface Draft {
  shopProductId: string;
  name: string;
  description: string;
  kind: PlanKind;
  slot: PlanSlot;
  slotWindow: string;
  serviceDays: number[];
  allowedFrequencies: SubscriptionFrequency[];
  price: string;
  termDays: number[];
  leadDays: number;
  isActive: boolean;
}

const blank = (listing?: PlanListingOption): Draft => ({
  shopProductId: listing?.shopProductId ?? "",
  name: listing?.name ?? "",
  description: "",
  kind: "MEAL",
  slot: "LUNCH",
  slotWindow: "",
  serviceDays: [1, 2, 3, 4, 5, 6, 7],
  allowedFrequencies: ["DAILY", "WEEKLY"],
  price: "",
  termDays: [],
  leadDays: 1,
  isActive: true,
});

const fromPlan = (p: ManagedPlan): Draft => ({
  shopProductId: p.shopProductId,
  name: p.name,
  description: p.description ?? "",
  kind: p.kind,
  slot: p.slot,
  slotWindow: p.slotWindow ?? "",
  serviceDays: p.serviceDays,
  allowedFrequencies: p.allowedFrequencies,
  price: p.pricePaise != null ? String(paiseToRupees(p.pricePaise)) : "",
  termDays: p.termDays,
  leadDays: p.leadDays,
  isActive: p.isActive,
});

/**
 * Seller Central's subscription plans (docs/subscription-plans-2026-11): make
 * any of the shop's products a plan — a daily lunch, a morning milk round, a
 * newspaper — choose its kind, slot, days, schedules, price and terms, switch
 * it on or off, and see how many subscribe.
 */
export function ShopPlansManager({
  shopId,
  plans,
  listings,
}: {
  shopId: string;
  plans: ManagedPlan[];
  listings: PlanListingOption[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(plans.length === 0 ? "new" : null);
  const [draft, setDraft] = useState<Draft>(() => blank(listings[0]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listingOf = (id: string) => listings.find((l) => l.shopProductId === id);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const problem =
    planRulesProblem({ allowedFrequencies: draft.allowedFrequencies, serviceDays: draft.serviceDays, termDays: draft.termDays, leadDays: draft.leadDays }) ??
    (draft.name.trim().length < 2 ? "Give the plan a name." : null) ??
    (!draft.shopProductId ? "Choose the product." : null) ??
    (!draft.price && listingOf(draft.shopProductId)?.onlinePricePaise == null ? "Set a subscriber price: this product has no online price." : null);

  function startNew() {
    setDraft(blank(listings[0]));
    setEditing("new");
    setError(null);
  }
  function startEdit(p: ManagedPlan) {
    setDraft(fromPlan(p));
    setEditing(p.id);
    setError(null);
  }

  async function send(method: string, url: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = res.status === 204 ? null : await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(payload?.error?.message ?? "Could not save the plan.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function save() {
    const body = {
      shopProductId: draft.shopProductId,
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      kind: draft.kind,
      slot: draft.slot,
      slotWindow: draft.slotWindow.trim() || null,
      serviceDays: [...draft.serviceDays].sort((a, b) => a - b),
      allowedFrequencies: draft.allowedFrequencies,
      pricePaise: draft.price ? rupeesToPaise(Number(draft.price)) : null,
      termDays: [...draft.termDays].sort((a, b) => a - b),
      leadDays: draft.leadDays,
      isActive: draft.isActive,
    };
    const ok =
      editing === "new"
        ? await send("POST", `/api/shops/${shopId}/subscription-plans`, body)
        : await send("PUT", `/api/shops/${shopId}/subscription-plans/${editing}`, body);
    if (ok) setEditing(null);
  }

  const chip = (on: boolean) =>
    `rounded-lg border px-3 py-1.5 text-sm font-medium ${on ? "border-kesari-500 bg-kesari-50 text-kesari-700" : "border-cream-200 bg-white text-ink-600"}`;

  const form = (
    <Card className="space-y-4 p-5" data-testid="plan-form">
      <h2 className="text-lg font-semibold text-ink-900">{editing === "new" ? "New subscription plan" : "Edit plan"}</h2>
      {listings.length === 0 ? (
        <Alert tone="warning">
          Add the product first (for example &quot;Veg lunch thali&quot;, unit piece) under{" "}
          <a href="/shop/product-categories" className="font-medium underline">
            Products
          </a>
          , then make it a plan here.
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Product delivered</span>
          <select
            value={draft.shopProductId}
            onChange={(e) => set({ shopProductId: e.target.value, name: draft.name || listingOf(e.target.value)?.name || "" })}
            className={inputClass}
          >
            {listings.map((l) => (
              <option key={l.shopProductId} value={l.shopProductId}>
                {l.name} ({l.unit}){l.onlinePricePaise != null ? ` — ₹${paiseToRupees(l.onlinePricePaise)}` : " — no online price"}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Plan name</span>
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} className={inputClass} placeholder="Veg lunch thali — monthly" maxLength={120} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Kind of plan</span>
          <select value={draft.kind} onChange={(e) => set({ kind: e.target.value as PlanKind })} className={inputClass}>
            {PLAN_KINDS.map((k) => (
              <option key={k} value={k}>
                {PLAN_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Delivery slot</span>
          <select value={draft.slot} onChange={(e) => set({ slot: e.target.value as PlanSlot })} className={inputClass}>
            {PLAN_SLOTS.map((s) => (
              <option key={s} value={s}>
                {slotLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">
            Your time window <span className="font-normal text-ink-500">(optional)</span>
          </span>
          <input
            value={draft.slotWindow}
            onChange={(e) => set({ slotWindow: e.target.value })}
            className={inputClass}
            placeholder={PLAN_SLOT_LABELS[draft.slot].window ?? "e.g. 12:30–2 pm"}
            maxLength={40}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">
            Subscriber price per unit, ₹ <span className="font-normal text-ink-500">(empty = your online price)</span>
          </span>
          <input
            type="number"
            min={0.01}
            step={0.01}
            inputMode="decimal"
            value={draft.price}
            onChange={(e) => set({ price: e.target.value })}
            className={inputClass}
            placeholder={listingOf(draft.shopProductId)?.onlinePricePaise != null ? String(paiseToRupees(listingOf(draft.shopProductId)!.onlinePricePaise!)) : "e.g. 80"}
          />
        </label>
      </div>

      <div>
        <span className="mb-2 block text-sm font-medium text-ink-700">Days you deliver this plan</span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days you deliver this plan">
          {WEEKDAY_SHORT.map((label, i) => (
            <button key={label} type="button" aria-pressed={draft.serviceDays.includes(i + 1)} className={chip(draft.serviceDays.includes(i + 1))} onClick={() => set({ serviceDays: toggle(draft.serviceDays, i + 1) })}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="mb-2 block text-sm font-medium text-ink-700">Customers may subscribe for</span>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Customers may subscribe for">
          {(["DAILY", "WEEKLY", "MONTHLY"] as SubscriptionFrequency[]).map((f) => (
            <button key={f} type="button" aria-pressed={draft.allowedFrequencies.includes(f)} className={chip(draft.allowedFrequencies.includes(f))} onClick={() => set({ allowedFrequencies: toggle(draft.allowedFrequencies, f) })}>
              {FREQ_LABELS[f]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="mb-2 block text-sm font-medium text-ink-700">
          Fixed plan lengths <span className="font-normal text-ink-500">(none = open-ended)</span>
        </span>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Fixed plan lengths">
          {TERM_CHOICES.map((d) => (
            <button key={d} type="button" aria-pressed={draft.termDays.includes(d)} className={chip(draft.termDays.includes(d))} onClick={() => set({ termDays: toggle(draft.termDays, d) })}>
              {d} days
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Days before the first delivery</span>
          <input type="number" min={0} max={30} value={draft.leadDays} onChange={(e) => set({ leadDays: Math.max(0, Math.min(30, Math.floor(Number(e.target.value) || 0))) })} className={inputClass} />
        </label>
        <label className="flex items-center gap-2 self-end text-sm font-medium text-ink-700">
          <input type="checkbox" className="h-4 w-4 accent-kesari-600" checked={draft.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
          Taking new subscribers
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">
          Description <span className="font-normal text-ink-500">(optional — menu, what is included)</span>
        </span>
        <textarea value={draft.description} onChange={(e) => set({ description: e.target.value })} className={inputClass} rows={2} maxLength={500} />
      </label>

      {problem ? <p className="text-sm text-ink-600">{problem}</p> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || Boolean(problem)} onClick={save}>
          {busy ? "Saving…" : editing === "new" ? "Create plan" : "Save plan"}
        </Button>
        {plans.length > 0 ? (
          <Button variant="secondary" disabled={busy} onClick={() => setEditing(null)}>
            Cancel
          </Button>
        ) : null}
      </div>
    </Card>
  );

  return (
    <div className="space-y-6">
      {editing ? form : (
        <Button onClick={startNew} disabled={listings.length === 0}>
          New subscription plan
        </Button>
      )}

      {plans.length === 0 && !editing ? (
        <EmptyState title="No subscription plans yet" description="Make any product a plan — daily lunch, morning milk, a newspaper — and customers near you can subscribe." />
      ) : null}

      {plans.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="shop-plans">
          {plans.map((p) => (
            <Card key={p.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={p.isActive ? "success" : "neutral"}>{p.isActive ? "Taking subscribers" : "Off"}</Badge>
                <Badge tone="info">{PLAN_KIND_LABELS[p.kind]}</Badge>
                <Badge>{slotLabel(p.slot, p.slotWindow)}</Badge>
              </div>
              <h3 className="font-semibold text-ink-900">{p.name}</h3>
              <p className="text-sm text-ink-600">
                {p.productName} · {serviceDaysLabel(p.serviceDays)} ·{" "}
                {p.effectivePricePaise != null ? <Money paise={p.effectivePricePaise} /> : "no price"} per {p.unit}
                {p.pricePaise != null ? " (subscriber price)" : ""}
              </p>
              <p className="text-sm text-ink-700">
                <strong>{p.subscribers}</strong> subscriber{p.subscribers === 1 ? "" : "s"}
                {p.termDays.length ? ` · ${p.termDays.join("/")} days` : " · open-ended"}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => startEdit(p)}>
                  Edit
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => send("PATCH", `/api/shops/${shopId}/subscription-plans/${p.id}`, { isActive: !p.isActive })}>
                  {p.isActive ? "Turn off" : "Turn on"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Remove "${p.name}"? Running subscribers keep their deliveries until they cancel.`)) {
                      void send("DELETE", `/api/shops/${shopId}/subscription-plans/${p.id}`);
                    }
                  }}
                >
                  Remove
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
