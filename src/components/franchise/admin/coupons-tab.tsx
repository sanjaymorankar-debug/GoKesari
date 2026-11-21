"use client";
/**
 * Admin → Franchise → Coupons (§5.7): create / edit, pause / resume, assign private coupons to dealers, usage and
 * discount report, Excel export. Coupons change only the franchise fee, never a commission. Operators read only.
 */
import { useEffect, useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";
import { formatIst, rupees } from "@/lib/franchise";

import { COUPON_XLSX, call, isoToIstInput, istInputToIso, type Act, type AdminZone, type Tier } from "./shared";

interface Coupon {
  id: string;
  code: string;
  name: string;
  note: string | null;
  discountType: "PERCENT" | "FLAT";
  percentBp: number | null;
  flatPaise: number | null;
  maxDiscountPaise: number | null;
  scope: { all?: boolean; zoneSets?: string[]; tiers?: Tier[]; zones?: string[] };
  appliesOn: "NEW" | "RENEWAL" | "BOTH";
  visibility: "PUBLIC" | "PRIVATE";
  startsAt: string;
  endsAt: string;
  totalLimit: number | null;
  perDealerLimit: number | null;
  minCartPaise: number | null;
  firstPurchaseOnly: boolean;
  launchOnly: boolean;
  status: "ACTIVE" | "PAUSED";
}
interface Row {
  coupon: Coupon;
  state: string;
  uses: number;
  dealers: number;
  discountPaise: number;
  revenueAfterDiscountPaise: number;
  assignments: { id: string; dealerId: string | null; mobileE164: string | null; email: string | null }[];
}
interface Use {
  code: string;
  dealer: string;
  bookingId: string;
  kind: string;
  zones: string;
  listPaise: number;
  discountPaise: number;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  usedAt: string | null;
}

interface Form {
  code: string;
  name: string;
  note: string;
  discountType: "PERCENT" | "FLAT";
  percent: string;
  flatRupees: string;
  maxRupees: string;
  scopeAll: boolean;
  zoneSets: string;
  tiers: Tier[];
  zones: string;
  appliesOn: "NEW" | "RENEWAL" | "BOTH";
  visibility: "PUBLIC" | "PRIVATE";
  startsAt: string;
  endsAt: string;
  totalLimit: string;
  perDealerLimit: string;
  minCartRupees: string;
  firstPurchaseOnly: boolean;
  launchOnly: boolean;
}

const EMPTY: Form = { code: "", name: "", note: "", discountType: "PERCENT", percent: "", flatRupees: "", maxRupees: "", scopeAll: true, zoneSets: "", tiers: [], zones: "", appliesOn: "BOTH", visibility: "PUBLIC", startsAt: "", endsAt: "", totalLimit: "", perDealerLimit: "", minCartRupees: "", firstPurchaseOnly: false, launchOnly: false };

const list = (s: string) => s.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
const num = (s: string) => (s.trim() === "" ? null : Number(s));
const paise = (s: string) => (s.trim() === "" ? null : Math.round(Number(s) * 100));

function toForm(c: Coupon): Form {
  return {
    code: c.code,
    name: c.name,
    note: c.note ?? "",
    discountType: c.discountType,
    percent: c.percentBp != null ? String(c.percentBp / 100) : "",
    flatRupees: c.flatPaise != null ? String(c.flatPaise / 100) : "",
    maxRupees: c.maxDiscountPaise != null ? String(c.maxDiscountPaise / 100) : "",
    scopeAll: !!c.scope.all,
    zoneSets: (c.scope.zoneSets ?? []).join(", "),
    tiers: c.scope.tiers ?? [],
    zones: (c.scope.zones ?? []).join(", "),
    appliesOn: c.appliesOn,
    visibility: c.visibility,
    startsAt: isoToIstInput(c.startsAt),
    endsAt: isoToIstInput(c.endsAt),
    totalLimit: c.totalLimit != null ? String(c.totalLimit) : "",
    perDealerLimit: c.perDealerLimit != null ? String(c.perDealerLimit) : "",
    minCartRupees: c.minCartPaise != null ? String(c.minCartPaise / 100) : "",
    firstPurchaseOnly: c.firstPurchaseOnly,
    launchOnly: c.launchOnly,
  };
}

function toBody(f: Form) {
  return {
    code: f.code.trim(),
    name: f.name.trim(),
    note: f.note.trim() || null,
    discountType: f.discountType,
    percentBp: f.discountType === "PERCENT" ? Math.round(Number(f.percent) * 100) : null,
    flatPaise: f.discountType === "FLAT" ? paise(f.flatRupees) : null,
    maxDiscountPaise: f.discountType === "PERCENT" ? paise(f.maxRupees) : null,
    scope: f.scopeAll ? { all: true } : { all: false, zoneSets: list(f.zoneSets), tiers: f.tiers, zones: list(f.zones) },
    appliesOn: f.appliesOn,
    visibility: f.visibility,
    startsAt: istInputToIso(f.startsAt),
    endsAt: istInputToIso(f.endsAt),
    totalLimit: num(f.totalLimit),
    perDealerLimit: num(f.perDealerLimit),
    minCartPaise: paise(f.minCartRupees),
    firstPurchaseOnly: f.firstPurchaseOnly,
    launchOnly: f.launchOnly,
  };
}

const value = (c: Coupon) => (c.discountType === "PERCENT" ? `${(c.percentBp ?? 0) / 100}%${c.maxDiscountPaise ? ` (max ${rupees(c.maxDiscountPaise)})` : ""}` : rupees(c.flatPaise ?? 0));
const STATE_TONE: Record<string, "success" | "warning" | "neutral" | "info"> = { ACTIVE: "success", PAUSED: "warning", EXPIRED: "neutral", SCHEDULED: "info" };

export function CouponsTab({ zones, tierNames, isAdmin, act }: { zones: AdminZone[]; tierNames: Record<Tier, string>; isAdmin: boolean; act: Act }) {
  const [data, setData] = useState<{ coupons: Row[]; uses: Use[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [assign, setAssign] = useState<{ id: string; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    call<{ coupons: Row[]; uses: Use[] }>("/api/admin/franchise/coupons", "GET")
      .then((r) => alive && setData(r))
      .catch((e) => alive && setErr(String(e.message)));
    return () => {
      alive = false;
    };
  }, [tick]);
  const wrap: Act = async (fn, ok) => {
    await act(fn, ok);
    setTick((t) => t + 1);
  };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = () =>
    wrap(
      () =>
        call(editing ? `/api/admin/franchise/coupons/${editing}` : "/api/admin/franchise/coupons", editing ? "PUT" : "POST", toBody(form)).then((r) => {
          setForm(EMPTY);
          setEditing(null);
          return r;
        }),
      editing ? "Coupon saved" : "Coupon created",
    );
  const sendAssign = (id: string, text: string) => {
    const dealers = text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (l.includes("@") ? { email: l } : /^\+?\d[\d\s]{9,}$/.test(l) ? { mobileE164: l.startsWith("+") ? l.replace(/\s/g, "") : `+91${l.replace(/\s/g, "").slice(-10)}` } : { dealerId: l }));
    return wrap(
      () =>
        call(`/api/admin/franchise/coupons/${id}`, "PATCH", { action: "assign", dealers }).then((r) => {
          setAssign(null);
          return r;
        }),
      `Assigned to ${dealers.length} dealer(s)`,
    );
  };
  if (!data) return <Card className="p-4 text-sm text-ink-600">{err ?? "Loading coupons…"}</Card>;
  return (
    <div className="space-y-4" data-testid="admin-coupons">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold text-ink-900">Franchise fee coupons</h2>
          <a className="inline-flex min-h-10 items-center rounded-lg border border-cream-200 px-3 text-sm" href={COUPON_XLSX}>
            Export to Excel
          </a>
        </div>
        <p className="text-xs text-ink-600">One coupon per order. The discount comes off the zone fees before GST (GST on the discounted amount); the fee never goes below ₹1. A use counts only once the payment succeeds and is released if it fails, times out or is fully refunded. Coupons never change a commission. Times are IST.</p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="text-left text-ink-500">
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Discount</th>
                <th>On</th>
                <th>Scope</th>
                <th>Valid (IST)</th>
                <th>Limits</th>
                <th>State</th>
                <th className="text-right">Uses</th>
                <th className="text-right">Discount given</th>
                <th className="text-right">Revenue after</th>
                {isAdmin ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {data.coupons.map((r) => (
                <tr key={r.coupon.id} className="border-t border-cream-100 align-top">
                  <td className="font-mono font-semibold">{r.coupon.code}</td>
                  <td>
                    {r.coupon.name}
                    <div className="text-ink-500">{r.coupon.visibility === "PRIVATE" ? `Private · ${r.assignments.length} assigned` : "Public"}</div>
                  </td>
                  <td>{value(r.coupon)}</td>
                  <td>{r.coupon.appliesOn}</td>
                  <td>{r.coupon.scope.all ? "All zones" : [r.coupon.scope.zoneSets?.join(", "), r.coupon.scope.tiers?.map((t) => tierNames[t]).join(", "), r.coupon.scope.zones?.join(", ")].filter(Boolean).join(" · ")}</td>
                  <td className="whitespace-nowrap">
                    {formatIst(r.coupon.startsAt)}
                    <br />
                    {formatIst(r.coupon.endsAt)}
                  </td>
                  <td>
                    {[r.coupon.totalLimit ? `total ${r.coupon.totalLimit}` : null, r.coupon.perDealerLimit ? `per dealer ${r.coupon.perDealerLimit}` : null, r.coupon.minCartPaise ? `min ${rupees(r.coupon.minCartPaise)}` : null, r.coupon.firstPurchaseOnly ? "first purchase" : null, r.coupon.launchOnly ? "launch 25 only" : null].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td>
                    <Badge tone={STATE_TONE[r.state] ?? "neutral"}>{r.state}</Badge>
                  </td>
                  <td className="text-right">
                    {r.uses} ({r.dealers} dealers)
                  </td>
                  <td className="text-right">{rupees(r.discountPaise)}</td>
                  <td className="text-right">{rupees(r.revenueAfterDiscountPaise)}</td>
                  {isAdmin ? (
                    <td className="space-y-1 whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setEditing(r.coupon.id);
                          setForm(toForm(r.coupon));
                        }}
                      >
                        Edit
                      </Button>{" "}
                      <Button size="sm" variant="ghost" onClick={() => wrap(() => call(`/api/admin/franchise/coupons/${r.coupon.id}`, "PATCH", { action: r.coupon.status === "PAUSED" ? "resume" : "pause" }), r.coupon.status === "PAUSED" ? "Resumed" : "Paused")}>
                        {r.coupon.status === "PAUSED" ? "Resume" : "Pause"}
                      </Button>{" "}
                      {r.coupon.visibility === "PRIVATE" ? (
                        <Button size="sm" variant="ghost" onClick={() => setAssign({ id: r.coupon.id, text: "" })}>
                          Assign
                        </Button>
                      ) : null}
                      {r.assignments.map((a) => (
                        <div key={a.id} className="text-ink-600">
                          {a.dealerId ?? a.mobileE164 ?? a.email}{" "}
                          <button type="button" className="text-red-700 underline" onClick={() => wrap(() => call(`/api/admin/franchise/coupons/${r.coupon.id}?assignment=${a.id}`, "DELETE"), "Assignment removed")}>
                            remove
                          </button>
                        </div>
                      ))}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          {!data.coupons.length ? <p className="text-sm text-ink-600">No coupons yet.</p> : null}
        </div>
        {assign ? (
          <div className="space-y-2 rounded-lg border border-cream-200 p-3">
            <p className="text-sm font-semibold">Assign to dealers — one per line: dealer id, mobile (+91…) or e-mail</p>
            <textarea className={`${inputClass} h-28 font-mono text-xs`} value={assign.text} onChange={(e) => setAssign({ ...assign, text: e.target.value })} />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => sendAssign(assign.id, assign.text)} disabled={!assign.text.trim()}>
                Assign
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAssign(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      {isAdmin ? (
        <Card className="space-y-3 p-4">
          <h3 className="font-bold text-ink-900">{editing ? `Edit coupon ${form.code}` : "New coupon"}</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-sm text-ink-700">
              Code (unique, any case)
              <input className={inputClass} value={form.code} onChange={(e) => set("code", e.target.value)} />
            </label>
            <label className="text-sm text-ink-700">
              Name
              <input className={inputClass} value={form.name} onChange={(e) => set("name", e.target.value)} />
            </label>
            <label className="text-sm text-ink-700">
              Internal note
              <input className={inputClass} value={form.note} onChange={(e) => set("note", e.target.value)} />
            </label>
            <label className="text-sm text-ink-700">
              Discount type
              <select className={inputClass} value={form.discountType} onChange={(e) => set("discountType", e.target.value as Form["discountType"])}>
                <option value="PERCENT">% of fee</option>
                <option value="FLAT">Flat ₹</option>
              </select>
            </label>
            {form.discountType === "PERCENT" ? (
              <>
                <label className="text-sm text-ink-700">
                  Discount %
                  <input className={inputClass} inputMode="decimal" value={form.percent} onChange={(e) => set("percent", e.target.value)} />
                </label>
                <label className="text-sm text-ink-700">
                  Maximum discount ₹ (blank = no cap)
                  <input className={inputClass} inputMode="decimal" value={form.maxRupees} onChange={(e) => set("maxRupees", e.target.value)} />
                </label>
              </>
            ) : (
              <label className="text-sm text-ink-700">
                Discount ₹ (split across eligible zones by fee)
                <input className={inputClass} inputMode="decimal" value={form.flatRupees} onChange={(e) => set("flatRupees", e.target.value)} />
              </label>
            )}
            <label className="text-sm text-ink-700">
              Applies on
              <select className={inputClass} value={form.appliesOn} onChange={(e) => set("appliesOn", e.target.value as Form["appliesOn"])}>
                <option value="BOTH">New purchase and renewal</option>
                <option value="NEW">New purchase</option>
                <option value="RENEWAL">Renewal</option>
              </select>
            </label>
            <label className="text-sm text-ink-700">
              Visibility
              <select className={inputClass} value={form.visibility} onChange={(e) => set("visibility", e.target.value as Form["visibility"])}>
                <option value="PUBLIC">Public (anyone)</option>
                <option value="PRIVATE">Private (assigned dealers)</option>
              </select>
            </label>
            <label className="text-sm text-ink-700">
              Starts (IST)
              <input className={inputClass} type="datetime-local" value={form.startsAt} onChange={(e) => set("startsAt", e.target.value)} />
            </label>
            <label className="text-sm text-ink-700">
              Ends (IST)
              <input className={inputClass} type="datetime-local" value={form.endsAt} onChange={(e) => set("endsAt", e.target.value)} />
            </label>
            <label className="text-sm text-ink-700">
              Total uses (blank = unlimited)
              <input className={inputClass} inputMode="numeric" value={form.totalLimit} onChange={(e) => set("totalLimit", e.target.value)} />
            </label>
            <label className="text-sm text-ink-700">
              Uses per dealer (blank = unlimited)
              <input className={inputClass} inputMode="numeric" value={form.perDealerLimit} onChange={(e) => set("perDealerLimit", e.target.value)} />
            </label>
            <label className="text-sm text-ink-700">
              Minimum cart ₹ before GST (blank = none)
              <input className={inputClass} inputMode="decimal" value={form.minCartRupees} onChange={(e) => set("minCartRupees", e.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-ink-700">
            <label className="inline-flex items-center gap-1">
              <input type="checkbox" checked={form.firstPurchaseOnly} onChange={(e) => set("firstPurchaseOnly", e.target.checked)} /> First purchase only
            </label>
            <label className="inline-flex items-center gap-1">
              <input type="checkbox" checked={form.launchOnly} onChange={(e) => set("launchOnly", e.target.checked)} /> Launch-offer dealers only (first 25)
            </label>
            <label className="inline-flex items-center gap-1">
              <input type="checkbox" checked={form.scopeAll} onChange={(e) => set("scopeAll", e.target.checked)} /> All zones
            </label>
          </div>
          {!form.scopeAll ? (
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="text-sm text-ink-700">
                Zone sets (e.g. PUN)
                <input className={inputClass} value={form.zoneSets} onChange={(e) => set("zoneSets", e.target.value)} />
              </label>
              <fieldset className="text-sm text-ink-700">
                <legend>Tiers</legend>
                {(["PREMIER", "STANDARD", "EMERGING"] as Tier[]).map((t) => (
                  <label key={t} className="mr-3 inline-flex items-center gap-1">
                    <input type="checkbox" checked={form.tiers.includes(t)} onChange={(e) => set("tiers", e.target.checked ? [...form.tiers, t] : form.tiers.filter((x) => x !== t))} /> {tierNames[t]}
                  </label>
                ))}
              </fieldset>
              <label className="text-sm text-ink-700">
                Zones (codes, comma-separated)
                <input className={inputClass} value={form.zones} onChange={(e) => set("zones", e.target.value)} placeholder={zones.slice(0, 2).map((z) => z.zoneId).join(", ")} />
              </label>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button onClick={save} disabled={!form.code.trim() || !form.name.trim() || !form.startsAt || !form.endsAt}>
              {editing ? "Save coupon" : "Create coupon"}
            </Button>
            {editing ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(null);
                  setForm(EMPTY);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card className="space-y-2 p-4">
        <h3 className="font-bold text-ink-900">Coupon uses (paid)</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="text-left text-ink-500">
              <tr>
                <th>Used (IST)</th>
                <th>Code</th>
                <th>Dealer</th>
                <th>Kind</th>
                <th>Zones</th>
                <th className="text-right">List fee</th>
                <th className="text-right">Discount</th>
                <th className="text-right">Taxable</th>
                <th className="text-right">GST</th>
                <th className="text-right">Total paid</th>
              </tr>
            </thead>
            <tbody>
              {data.uses.map((u) => (
                <tr key={u.bookingId} className="border-t border-cream-100">
                  <td>{formatIst(u.usedAt)}</td>
                  <td className="font-mono">{u.code}</td>
                  <td>{u.dealer}</td>
                  <td>{u.kind}</td>
                  <td>{u.zones}</td>
                  <td className="text-right">{rupees(u.listPaise)}</td>
                  <td className="text-right">{rupees(u.discountPaise)}</td>
                  <td className="text-right">{rupees(u.basePaise)}</td>
                  <td className="text-right">{rupees(u.gstPaise)}</td>
                  <td className="text-right">{rupees(u.totalPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.uses.length ? <p className="text-sm text-ink-600">No paid uses yet.</p> : null}
        </div>
      </Card>
      {err ? <Alert tone="danger">{err}</Alert> : null}
    </div>
  );
}
