"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ShopCategoryPicker, type PickerCategory } from "@/components/shop-category-picker";
import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

export interface WorkShop {
  shopId: string;
  name: string;
  place: string;
  status: string;
  source: string;
  employee: string | null;
  employeeText: string | null;
  matchKind: string;
  attributedAt: string;
}

export interface WorkLead {
  id: string;
  shopName: string;
  ownerName: string | null;
  mobileMasked: string;
  pincode: string | null;
  status: string;
  expiresAt: string;
  closedReason: string | null;
}

export interface WorkClaim {
  id: string;
  status: string;
  phoneTail: string;
  note: string;
  resolutionNote: string | null;
  createdAt: string;
}

interface Employee {
  id: string;
  name: string;
  employeeId: string;
  status: string;
}

const SOURCE: Record<string, string> = {
  CODE_AT_REGISTRATION: "your code",
  DEALER_ASSISTED: "registered by you",
  LEAD: "your lead",
  ADMIN: "claim upheld",
};

async function send<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
    const detail = fields ? ` ${Object.values(fields).join(" ")}` : "";
    throw new Error(`${payload?.error?.message ?? "That did not work."}${detail}`);
  }
  return payload as T;
}

const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * The dealer's work (docs/dealer-programme, GKS-SH-002, GKS-RA-001): register
 * a shop for its owner (the owner's code first), log leads, the shops counted
 * for the dealer, and claims for shops the dealer believes are theirs.
 */
export function DealerWork({
  employees,
  shops,
  leads,
  claims,
  shopTypes,
  categories,
  askTurnover,
}: {
  employees: Employee[];
  shops: WorkShop[];
  leads: WorkLead[];
  claims: WorkClaim[];
  shopTypes: { key: string; label: string }[];
  categories: PickerCategory[];
  askTurnover: boolean;
}) {
  const router = useRouter();
  const active = employees.filter((e) => e.status === "ACTIVE");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Register a shop
  const [owner, setOwner] = useState({ ownerName: "", ownerMobile: "", ownerEmail: "", salespersonId: "" });
  const [session, setSession] = useState<{ id: string; status: string; sentTo: string; channel: string } | null>(null);
  const [otp, setOtp] = useState("");
  const [shop, setShop] = useState({ name: "", addressLine1: "", area: "", city: "", pincode: "", shopType: "", gstin: "", panNumber: "", shopActNumber: "", turnover: "" });
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [terms, setTerms] = useState(false);

  // Leads and claims
  const [lead, setLead] = useState({ shopName: "", ownerName: "", mobile: "", gstin: "", pincode: "", salespersonId: "", consent: false });
  const [claim, setClaim] = useState({ mobile: "", note: "" });

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  const ownerMobileDigits = owner.ownerMobile.replace(/\D/g, "").slice(-10);

  return (
    <div className="space-y-4" data-testid="dealer-work">
      {error ? <Alert tone="danger" title="Could not do that">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card className="space-y-3 p-4" data-testid="dealer-register-shop">
        <h2 className="text-base font-bold text-ink-900">Register a shop for its owner</h2>
        <p className="text-sm text-ink-700">
          The owner confirms with a code sent to them, and pays the registration fee from their own account. Your code is attached
          automatically.
        </p>
        {!session || session.status === "SHOP_SUBMITTED" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Owner's name">
              <input className={inputClass} value={owner.ownerName} onChange={(e) => setOwner((o) => ({ ...o, ownerName: e.target.value }))} maxLength={120} />
            </Field>
            <Field label="Owner's mobile">
              <input className={inputClass} inputMode="numeric" value={owner.ownerMobile} onChange={(e) => setOwner((o) => ({ ...o, ownerMobile: e.target.value }))} maxLength={14} />
            </Field>
            <Field label="Owner's email" hint="They sign in with it to pay the fee and run the shop.">
              <input className={inputClass} type="email" value={owner.ownerEmail} onChange={(e) => setOwner((o) => ({ ...o, ownerEmail: e.target.value }))} maxLength={254} />
            </Field>
            <Field label="Your employee handling it (optional)">
              <select className={inputClass} value={owner.salespersonId} onChange={(e) => setOwner((o) => ({ ...o, salespersonId: e.target.value }))}>
                <option value="">— none —</option>
                {active.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.employeeId})
                  </option>
                ))}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Button
                disabled={busy !== null}
                onClick={() =>
                  run("start", async () => {
                    const res = await send<{ session: { id: string; status: string; sentTo: string; channel: string } }>(
                      "/api/dealer/assisted",
                      json({ ...owner, salespersonId: owner.salespersonId || null }),
                    );
                    setSession(res.session);
                    setOtp("");
                    return `Code sent to the owner (${res.session.channel === "SMS" ? "SMS" : "email"}: ${res.session.sentTo}). Ask them for it.`;
                  })
                }
              >
                Send the owner a code
              </Button>
            </div>
          </div>
        ) : session.status === "OTP_SENT" ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={`Code the owner received (${session.sentTo})`}>
              <input className={inputClass} inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value)} maxLength={10} autoComplete="off" />
            </Field>
            <Button
              disabled={busy !== null || !otp.trim()}
              onClick={() =>
                run("verify", async () => {
                  const res = await send<{ session: { id: string; status: string; sentTo: string; channel: string } }>(`/api/dealer/assisted/${session.id}/verify`, json({ code: otp.trim() }));
                  setSession(res.session);
                  return "The owner confirmed. Fill in the shop's details.";
                })
              }
            >
              Confirm
            </Button>
            <Button variant="ghost" onClick={() => setSession(null)}>
              Start again
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Shop name">
                <input className={inputClass} value={shop.name} onChange={(e) => setShop((s) => ({ ...s, name: e.target.value }))} maxLength={120} />
              </Field>
              <Field label="Shop type">
                <select className={inputClass} value={shop.shopType} onChange={(e) => setShop((s) => ({ ...s, shopType: e.target.value }))}>
                  <option value="">Choose…</option>
                  {shopTypes.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Address">
                <input className={inputClass} value={shop.addressLine1} onChange={(e) => setShop((s) => ({ ...s, addressLine1: e.target.value }))} maxLength={200} />
              </Field>
              <Field label="Area">
                <input className={inputClass} value={shop.area} onChange={(e) => setShop((s) => ({ ...s, area: e.target.value }))} maxLength={120} />
              </Field>
              <Field label="City">
                <input className={inputClass} value={shop.city} onChange={(e) => setShop((s) => ({ ...s, city: e.target.value }))} maxLength={120} />
              </Field>
              <Field label="PIN code">
                <input className={inputClass} inputMode="numeric" value={shop.pincode} onChange={(e) => setShop((s) => ({ ...s, pincode: e.target.value }))} maxLength={6} />
              </Field>
              <Field label="GSTIN (if any)">
                <input className={inputClass} value={shop.gstin} onChange={(e) => setShop((s) => ({ ...s, gstin: e.target.value.toUpperCase() }))} maxLength={15} />
              </Field>
              <Field label="PAN (if no GSTIN)">
                <input className={inputClass} value={shop.panNumber} onChange={(e) => setShop((s) => ({ ...s, panNumber: e.target.value.toUpperCase() }))} maxLength={10} autoComplete="off" />
              </Field>
              <Field label="Shop Act number (if any)">
                <input className={inputClass} value={shop.shopActNumber} onChange={(e) => setShop((s) => ({ ...s, shopActNumber: e.target.value }))} maxLength={60} />
              </Field>
              {askTurnover ? (
                <Field label="Annual turnover (₹)" hint="Sets the registration fee the owner pays.">
                  <input className={inputClass} inputMode="numeric" value={shop.turnover} onChange={(e) => setShop((s) => ({ ...s, turnover: e.target.value }))} maxLength={20} />
                </Field>
              ) : null}
            </div>
            <ShopCategoryPicker value={categoryIds} onChange={setCategoryIds} initialCategories={categories} />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
              The owner has read and accepted GoKesari&apos;s terms for sellers.
            </label>
            <Button
              disabled={busy !== null}
              onClick={() =>
                run("shop", async () => {
                  const turnover = Number(shop.turnover.replace(/[,\s₹]/g, ""));
                  const res = await send<{ feeDuePaise: number; code: string | null }>(
                    `/api/dealer/assisted/${session.id}/shop`,
                    json({
                      ownerAcceptedTerms: terms,
                      shop: {
                        name: shop.name,
                        ownerName: owner.ownerName,
                        phone: ownerMobileDigits,
                        email: owner.ownerEmail || null,
                        addressLine1: shop.addressLine1,
                        area: shop.area || null,
                        city: shop.city,
                        pincode: shop.pincode,
                        shopType: shop.shopType,
                        categoryIds,
                        gstin: shop.gstin || null,
                        panNumber: shop.panNumber || null,
                        shopActNumber: shop.shopActNumber || null,
                        annualTurnoverRupees: askTurnover && shop.turnover.trim() && Number.isFinite(turnover) ? turnover : null,
                      },
                    }),
                  );
                  setSession({ ...session, status: "SHOP_SUBMITTED" });
                  setShop({ name: "", addressLine1: "", area: "", city: "", pincode: "", shopType: "", gstin: "", panNumber: "", shopActNumber: "", turnover: "" });
                  setCategoryIds([]);
                  setTerms(false);
                  return `Registered with your code ${res.code ?? ""}. The owner has been asked to pay the registration fee of ₹${(res.feeDuePaise / 100).toLocaleString("en-IN")}; the shop is reviewed as usual.`;
                })
              }
            >
              Register the shop
            </Button>
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-4" data-testid="dealer-leads">
        <h2 className="text-base font-bold text-ink-900">Leads</h2>
        <p className="text-sm text-ink-700">Log a shop you visited. If it registers without a code within the window, it is counted for the dealer who logged it first.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Shop name">
            <input className={inputClass} value={lead.shopName} onChange={(e) => setLead((l) => ({ ...l, shopName: e.target.value }))} maxLength={120} />
          </Field>
          <Field label="Owner's mobile">
            <input className={inputClass} inputMode="numeric" value={lead.mobile} onChange={(e) => setLead((l) => ({ ...l, mobile: e.target.value }))} maxLength={14} />
          </Field>
          <Field label="PIN code">
            <input className={inputClass} inputMode="numeric" value={lead.pincode} onChange={(e) => setLead((l) => ({ ...l, pincode: e.target.value }))} maxLength={6} />
          </Field>
          <Field label="Owner's name (optional)">
            <input className={inputClass} value={lead.ownerName} onChange={(e) => setLead((l) => ({ ...l, ownerName: e.target.value }))} maxLength={120} />
          </Field>
          <Field label="GSTIN (optional)">
            <input className={inputClass} value={lead.gstin} onChange={(e) => setLead((l) => ({ ...l, gstin: e.target.value.toUpperCase() }))} maxLength={15} />
          </Field>
          <Field label="Employee (optional)">
            <select className={inputClass} value={lead.salespersonId} onChange={(e) => setLead((l) => ({ ...l, salespersonId: e.target.value }))}>
              <option value="">— none —</option>
              {active.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={lead.consent} onChange={(e) => setLead((l) => ({ ...l, consent: e.target.checked }))} />
          The owner agreed to be contacted by us about joining GoKesari.
        </label>
        <Button
          disabled={busy !== null}
          onClick={() =>
            run("lead", async () => {
              await send("/api/dealer/leads", json({ ...lead, ownerConsent: lead.consent, salespersonId: lead.salespersonId || null, gstin: lead.gstin || null, ownerName: lead.ownerName || null }));
              setLead({ shopName: "", ownerName: "", mobile: "", gstin: "", pincode: "", salespersonId: "", consent: false });
              return "Lead saved.";
            })
          }
        >
          Save lead
        </Button>
        <ul className="divide-y divide-cream-200 text-sm">
          {leads.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-semibold">{l.shopName}</span> · {l.mobileMasked} · {l.pincode}{" "}
                <Badge tone={l.status === "OPEN" ? "info" : l.status === "CONVERTED" ? "success" : "neutral"}>{l.status.toLowerCase()}</Badge>
                <span className="block text-xs text-ink-500">{l.status === "OPEN" ? `Until ${l.expiresAt.slice(0, 10)}` : (l.closedReason ?? "")}</span>
              </span>
              {l.status === "OPEN" ? (
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => run(`close-${l.id}`, async () => void (await send(`/api/dealer/leads/${l.id}`, json({ status: "CLOSED" }, "PATCH"))))}>
                  Close
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-2 p-4" data-testid="dealer-shops">
        <h2 className="text-base font-bold text-ink-900">Your shops ({shops.length})</h2>
        {shops.length === 0 ? <p className="text-sm text-ink-500">No shops yet.</p> : null}
        <ul className="divide-y divide-cream-200 text-sm">
          {shops.map((s) => (
            <li key={s.shopId} className="py-2">
              <span className="font-semibold">{s.name}</span> · {s.place} <Badge>{s.status.toLowerCase().replace("_", " ")}</Badge>{" "}
              {s.matchKind !== "NONE" ? <Badge tone="warning">{s.matchKind === "BRANCH" ? "branch" : "possible duplicate"}</Badge> : null}
              <span className="block text-xs text-ink-500">
                {SOURCE[s.source] ?? s.source} · {s.attributedAt.slice(0, 10)}
                {s.employee ? ` · ${s.employee}` : s.employeeText ? ` · employee typed: "${s.employeeText}" (not matched)` : ""}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-3 p-4" data-testid="dealer-claims">
        <h2 className="text-base font-bold text-ink-900">Claim a shop</h2>
        <p className="text-sm text-ink-700">If a shop you brought was counted for someone else, tell us. GoKesari decides from the evidence.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Shop owner's mobile">
            <input className={inputClass} inputMode="numeric" value={claim.mobile} onChange={(e) => setClaim((c) => ({ ...c, mobile: e.target.value }))} maxLength={14} />
          </Field>
          <Field label="What happened">
            <input className={inputClass} value={claim.note} onChange={(e) => setClaim((c) => ({ ...c, note: e.target.value }))} maxLength={2000} />
          </Field>
        </div>
        <Button
          disabled={busy !== null}
          onClick={() =>
            run("claim", async () => {
              await send("/api/dealer/disputes", json(claim));
              setClaim({ mobile: "", note: "" });
              return "Claim received. We will tell you the decision.";
            })
          }
        >
          Send claim
        </Button>
        <ul className="divide-y divide-cream-200 text-sm">
          {claims.map((c) => (
            <li key={c.id} className="py-2">
              Mobile ending {c.phoneTail} <Badge tone={c.status === "UPHELD" ? "success" : c.status === "REJECTED" ? "danger" : "info"}>{c.status.toLowerCase()}</Badge>
              <span className="block text-xs text-ink-500">{c.resolutionNote ?? c.note}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
