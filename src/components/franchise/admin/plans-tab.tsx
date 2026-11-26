"use client";
/**
 * Admin → Franchise → Plans (docs/onboarding-v2-2026-11 §Defaults #4): the subscription plans a paid franchise is
 * bought on (Become a franchisee, flag onboarding_v2). Add, edit, deactivate / reactivate; every change is audited.
 * A plan without a price uses each zone's own tier fee. Operators read only. Times IST.
 */
import { useCallback, useEffect, useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";
import { formatIst, rupees } from "@/lib/franchise";
import { planPriceLabel } from "@/lib/franchise-plans";

import { call, type Act } from "./shared";

interface Plan {
  id: string;
  code: string;
  name: string;
  description: string;
  durationMonths: number;
  pricePerZonePaise: number | null;
  gstExtra: boolean;
  isLaunchOffer: boolean;
  active: boolean;
  sortOrder: number;
  updatedAt: string;
}

interface Form {
  code: string;
  name: string;
  description: string;
  durationMonths: string;
  /** Rupees; empty = the zone's tier fee. */
  priceRupees: string;
  gstExtra: boolean;
  isLaunchOffer: boolean;
  active: boolean;
  sortOrder: string;
}

const EMPTY: Form = { code: "", name: "", description: "", durationMonths: "12", priceRupees: "", gstExtra: true, isLaunchOffer: false, active: true, sortOrder: "0" };

const toForm = (p: Plan): Form => ({ code: p.code, name: p.name, description: p.description, durationMonths: String(p.durationMonths), priceRupees: p.pricePerZonePaise == null ? "" : String(p.pricePerZonePaise / 100), gstExtra: p.gstExtra, isLaunchOffer: p.isLaunchOffer, active: p.active, sortOrder: String(p.sortOrder) });

const toBody = (f: Form) => ({
  code: f.code.trim(),
  name: f.name.trim(),
  description: f.description.trim(),
  durationMonths: Number(f.durationMonths),
  pricePerZonePaise: f.priceRupees.trim() ? Math.round(Number(f.priceRupees) * 100) : null,
  gstExtra: f.gstExtra,
  isLaunchOffer: f.isLaunchOffer,
  active: f.active,
  sortOrder: Number(f.sortOrder) || 0,
});

export function PlansTab({ isAdmin, act }: { isAdmin: boolean; act: Act }) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const load = useCallback(async () => setPlans((await call<{ plans: Plan[] }>("/api/admin/franchise/plans", "GET")).plans), []);
  useEffect(() => {
    let alive = true;
    call<{ plans: Plan[] }>("/api/admin/franchise/plans", "GET")
      .then((r) => alive && setPlans(r.plans))
      .catch((e) => alive && setProblem(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const save = () =>
    act(async () => {
      const r = editing === "new" ? await call("/api/admin/franchise/plans", "POST", toBody(form)) : await call(`/api/admin/franchise/plans/${editing}`, "PUT", toBody(form));
      setEditing(null);
      await load();
      return r;
    }, editing === "new" ? "Plan added" : "Plan saved");

  const toggle = (p: Plan) =>
    act(async () => {
      const r = await call(`/api/admin/franchise/plans/${p.id}`, "PATCH", { active: !p.active });
      await load();
      return r;
    }, p.active ? "Plan deactivated — no new bookings on it" : "Plan active again");

  if (problem) return <Alert tone="danger">{problem}</Alert>;
  if (!plans) return <p className="text-sm text-ink-600">Loading…</p>;
  return (
    <Card className="space-y-3 p-4" data-testid="admin-plans">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-ink-900">Subscription plans</h2>
          <p className="text-xs text-ink-600">Offered on Become a franchisee (onboarding v2). Price per zone before GST; empty = each zone&apos;s tier fee. Bookings keep the plan and amount they were paid on.</p>
        </div>
        {isAdmin ? (
          <Button
            size="sm"
            onClick={() => {
              setForm(EMPTY);
              setEditing("new");
            }}
            data-testid="plan-add"
          >
            Add plan
          </Button>
        ) : null}
      </div>
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-cream-200 text-left text-xs text-ink-500">
            <th className="py-1 pr-2">Plan</th>
            <th className="py-1 pr-2">Price</th>
            <th className="py-1 pr-2">Status</th>
            <th className="py-1 pr-2">Updated (IST)</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.id} className="border-b border-cream-100 align-top">
              <td className="py-1 pr-2">
                <span className="font-semibold">{p.name}</span> <span className="text-xs text-ink-500">{p.code}</span>
                {p.isLaunchOffer ? (
                  <span className="ml-1">
                    <Badge tone="success">Launch offer</Badge>
                  </span>
                ) : null}
                {p.description ? <p className="text-xs text-ink-500">{p.description}</p> : null}
              </td>
              <td className="py-1 pr-2">{planPriceLabel(p, rupees)}</td>
              <td className="py-1 pr-2">
                <Badge tone={p.active ? "success" : "neutral"}>{p.active ? "Active" : "Inactive"}</Badge>
              </td>
              <td className="py-1 pr-2 text-xs">{formatIst(p.updatedAt)}</td>
              <td className="py-1 text-right">
                {isAdmin ? (
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setForm(toForm(p));
                        setEditing(p.id);
                      }}
                    >
                      Edit
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void toggle(p)} data-testid={`plan-toggle-${p.code}`}>
                      {p.active ? "Deactivate" : "Activate"}
                    </Button>
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
          {!plans.length ? (
            <tr>
              <td colSpan={5} className="py-2 text-ink-500">
                No plans yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {isAdmin && editing ? (
        <div className="space-y-2 rounded-lg border border-cream-200 p-3" data-testid="plan-form">
          <p className="text-sm font-semibold text-ink-900">{editing === "new" ? "New plan" : `Edit ${form.code}`}</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-sm text-ink-700">
              Code
              <input className={`${inputClass} mt-1 uppercase`} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} maxLength={40} placeholder="LAUNCH_1Y" />
            </label>
            <label className="text-sm text-ink-700 sm:col-span-2">
              Name
              <input className={`${inputClass} mt-1`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} />
            </label>
            <label className="text-sm text-ink-700 sm:col-span-3">
              Description
              <input className={`${inputClass} mt-1`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={500} />
            </label>
            <label className="text-sm text-ink-700">
              Price per zone ₹ (empty = tier fee)
              <input className={`${inputClass} mt-1`} inputMode="decimal" value={form.priceRupees} onChange={(e) => setForm({ ...form, priceRupees: e.target.value.replace(/[^\d.]/g, "") })} />
            </label>
            <label className="text-sm text-ink-700">
              Term (months)
              <input className={`${inputClass} mt-1`} inputMode="numeric" value={form.durationMonths} onChange={(e) => setForm({ ...form, durationMonths: e.target.value.replace(/\D/g, "") })} />
            </label>
            <label className="text-sm text-ink-700">
              Display order
              <input className={`${inputClass} mt-1`} inputMode="numeric" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value.replace(/[^\d-]/g, "") })} />
            </label>
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-ink-800">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.gstExtra} onChange={(e) => setForm({ ...form, gstExtra: e.target.checked })} /> GST on top
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.isLaunchOffer} onChange={(e) => setForm({ ...form, isLaunchOffer: e.target.checked })} /> Launch offer (counts towards the launch places)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active
            </label>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void save()} disabled={!form.code.trim() || !form.name.trim() || !form.durationMonths} data-testid="plan-save">
              Save
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
