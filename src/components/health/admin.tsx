"use client";

/**
 * GoKesari Health for admins and operators (docs/health/; owner brief §6, §7). One tab at a time, each
 * sized for a phone: verification queues, specialties by Health group, drug master, lists, Prime plans, settings, reports, access and
 * audit logs, break-glass (admins), DPDP data requests and the disputes link. The tabs offered come from
 * the server (operators: verification, drug master, lists, reports, logs, data requests).
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Alert, Badge } from "@/components/ui";
import type { HealthAdminTab } from "@/server/health/admin";
import { api, Chip, Panel, Tile } from "./api";
import { ADMIN_API, card, Loading, type Post } from "./admin-common";
import { DrugMaster, Lists } from "./admin-catalog";
import { AccessLogs, Reports } from "./admin-insights";
import { BreakGlass, DataRequests } from "./admin-privacy";
import { AdminPrime } from "./admin-prime";
import { Specialties } from "./admin-specialties";
import { Verification } from "./admin-verify";

const TAB_LABELS: Record<HealthAdminTab, string> = {
  verify: "Verification",
  specialties: "Specialties",
  drugs: "Drug master",
  lists: "Lists",
  prime: "Prime",
  settings: "Settings",
  reports: "Reports",
  logs: "Access & audit",
  breakglass: "Break-glass",
  requests: "Data requests",
  support: "Disputes",
};

export function HealthAdmin({ tabs, initialTab, breakGlassEnabled }: { tabs: HealthAdminTab[]; initialTab: HealthAdminTab; breakGlassEnabled: boolean }) {
  const [tab, setTab] = useState<HealthAdminTab>(tabs.includes(initialTab) ? initialTab : "verify");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    // On a phone the tab row scrolls sideways: keep the open tab in view.
    document.querySelector(`[data-testid="health-admin-tab-${tab}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [tab]);
  const choose = (t: HealthAdminTab) => {
    setTab(t);
    setError(null);
    setNotice(null);
    try {
      window.history.replaceState(null, "", `?tab=${t}`);
    } catch {
      /* the tab still changes */
    }
  };
  const post: Post = async (body, done) => {
    setError(null);
    setNotice(null);
    try {
      const result = await api<never>(ADMIN_API, { json: body });
      setNotice(typeof done === "function" ? done(result) : done);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not save.");
      return null;
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="health-admin">
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [&>*]:shrink-0" role="tablist" aria-label="Health admin sections">
        {tabs.map((t) => (
          <Chip key={t} active={tab === t} onClick={() => choose(t)} testId={`health-admin-tab-${t}`}>
            {TAB_LABELS[t]}
          </Chip>
        ))}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {tab === "verify" ? <Verification post={post} /> : null}
      {tab === "specialties" ? <Specialties /> : null}
      {tab === "drugs" ? <DrugMaster post={post} /> : null}
      {tab === "lists" ? <Lists post={post} /> : null}
      {tab === "prime" ? <AdminPrime /> : null}
      {tab === "settings" ? <Settings /> : null}
      {tab === "reports" ? <Reports /> : null}
      {tab === "logs" ? <AccessLogs /> : null}
      {tab === "breakglass" ? <BreakGlass post={post} enabled={breakGlassEnabled} /> : null}
      {tab === "requests" ? <DataRequests post={post} /> : null}
      {tab === "support" ? <Support /> : null}
    </div>
  );
}


interface SettingsView {
  health: Record<string, unknown>;
  consultBookingEnabled: boolean;
  live: boolean;
}

const SETTING_LABELS: Record<string, string> = {
  enabled: "Health switched on",
  storeResponseMinutes: "Store reply time (minutes)",
  rxValidityDays: "Prescription valid at stores (days)",
  rxCommissionBp: "Commission on medicine orders",
  rentalCommissionBp: "Commission on rentals",
  careCommissionBp: "Commission on home care",
  rentalDueReminderDays: "Rental due reminder (days before)",
  primeGraceDays: "Prime grace days",
  primeGstBp: "GST on Prime",
  primeTermDiscountBp: "Prime term discounts",
  payPerBooking: "Pay per booking (no subscription)",
  feePerBookingPaise: "Fee per booking",
  maxDocumentBytes: "Largest upload",
  shareLinkHours: "Share link valid (hours)",
  videoProvider: "Video calls",
  telephonyProvider: "Virtual numbers",
  printProvider: "Printing",
  breakGlassEnabled: "Break-glass allowed",
  freeListingManualApproval: "Free listing: clinic confirms bookings",
  careOtpMaxAttempts: "Care visit code attempts",
  familyLinkCodeMinutes: "Family link code valid (minutes)",
};

function showSetting(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (key.endsWith("Bp")) return `${value / 100}%`;
    if (key.endsWith("Paise")) return `₹${(value / 100).toLocaleString("en-IN")}`;
    if (key === "maxDocumentBytes") return `${Math.round(value / 100_000) / 10} MB`;
    return String(value);
  }
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${showSetting(key, v)}`).join(", ");
  return String(value ?? "—");
}

function Settings() {
  const [s, setS] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setS(await api<SettingsView>(`${ADMIN_API}?view=settings`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the settings.");
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) once
    void load();
  }, [load]);
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!s) return <Loading />;
  return (
    <div className="flex flex-col gap-3" data-testid="health-admin-settings">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile label="Health (rule health)" value={s.health.enabled ? "On" : "Off"} tone={s.health.enabled ? "green" : "amber"} />
        <Tile label="Bookings (consultBooking)" value={s.consultBookingEnabled ? "On" : "Off"} tone={s.consultBookingEnabled ? "green" : "amber"} />
        <Tile label="Patients can use Health" value={s.live ? "Yes" : "No"} tone={s.live ? "green" : "amber"} hint="Needs both switches on" />
      </div>
      <Panel
        title="Current values"
        action={
          <Link href="/admin/settings?rule=health" className="text-sm font-bold text-kesari-800 underline" data-testid="health-settings-edit">
            Change in Settings
          </Link>
        }
      >
        <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
          {Object.entries(s.health).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-cream-100 py-1">
              <dt className="text-ink-600">{SETTING_LABELS[k] ?? k}</dt>
              <dd className="text-right font-semibold text-ink-900">{showSetting(k, v)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-ink-600">
          Read-only here. The consultant booking switch is the rule{" "}
          <Link href="/admin/settings?rule=consultBooking" className="underline">
            consultBooking
          </Link>
          .
        </p>
      </Panel>
    </div>
  );
}

function Support() {
  const links: [string, string, string][] = [
    ["/admin/support?category=BOOKING", "Booking disputes", "Appointments, home-care visits and doctor bookings (category Booking)."],
    ["/admin/support?category=OTHER", "Other health tickets", "Medicine orders, rentals and anything else (category Other)."],
    ["/admin/consult?tab=bookings", "All appointments", "Refunds and staff cancellation of any booking."],
    ["/admin/support?category=GRIEVANCE", "Grievances", "Privacy and data-protection complaints to the Grievance Officer."],
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="health-admin-support">
      {links.map(([href, title, text]) => (
        <Link key={href} href={href} className={`${card} block min-h-11 hover:border-kesari-400`}>
          <p className="font-extrabold text-ink-900">
            {title} <Badge tone="info">Helpdesk</Badge>
          </p>
          <p className="text-sm text-ink-600">{text}</p>
        </Link>
      ))}
      <Link href="/admin/disputes" className="inline-flex min-h-11 items-center text-sm font-bold text-kesari-800 underline sm:col-span-2">
        Shop order disputes →
      </Link>
    </div>
  );
}
