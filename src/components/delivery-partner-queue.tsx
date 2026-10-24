"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, StatusBadge, inputClass } from "@/components/ui";
import { vehicleTypeLabel } from "@/lib/vehicle-types";

export interface AdminDeliveryPartner {
  id: string;
  fullName: string;
  mobile: string;
  email: string | null;
  vehicleType: string;
  vehicleRegistrationNumber: string | null;
  operatingRadiusKm: number;
  locationVerified: boolean;
  status: string;
  reviewNotes: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface DeliveryPartnerDashboard {
  REGISTERED?: number;
  UNDER_REVIEW?: number;
  APPROVED?: number;
  REJECTED?: number;
  SUSPENDED?: number;
  DEACTIVATED?: number;
}

/** Admin/operator delivery-partner verification queue (delivery-system Slice B) — mirrors ShopApprovalPanel's pattern. */
export function DeliveryPartnerQueue({
  partners,
  dashboard,
}: {
  partners: AdminDeliveryPartner[];
  dashboard: DeliveryPartnerDashboard;
}) {
  const [statusFilter, setStatusFilter] = useState("");
  const [query, setQuery] = useState("");

  const filtered = partners.filter((p) => {
    if (statusFilter && p.status !== statusFilter) return false;
    if (query) {
      const term = query.toLowerCase();
      if (!`${p.fullName} ${p.mobile}`.toLowerCase().includes(term)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        <Stat label="Registered" value={dashboard.REGISTERED ?? 0} />
        <Stat label="Under review" value={dashboard.UNDER_REVIEW ?? 0} />
        <Stat label="Approved" value={dashboard.APPROVED ?? 0} />
        <Stat label="Rejected" value={dashboard.REJECTED ?? 0} />
        <Stat label="Suspended" value={dashboard.SUSPENDED ?? 0} />
        <Stat label="Deactivated" value={dashboard.DEACTIVATED ?? 0} />
      </div>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-ink-500">Search</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or mobile"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-xs text-ink-500">Status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className={inputClass}
            >
              <option value="">All</option>
              {["REGISTERED", "UNDER_REVIEW", "APPROVED", "REJECTED", "SUSPENDED", "DEACTIVATED"].map(
                (s) => (
                  <option key={s} value={s}>
                    {s.replace("_", " ")}
                  </option>
                ),
              )}
            </select>
          </label>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState title="No delivery partners match those filters." />
      ) : (
        <div className="space-y-3">
          {filtered.map((partner) => (
            <PartnerRow key={partner.id} partner={partner} />
          ))}
        </div>
      )}
    </div>
  );
}

function PartnerRow({ partner }: { partner: AdminDeliveryPartner }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonMode, setReasonMode] = useState<"reject" | "suspend" | "reactivate" | "deactivate" | null>(null);
  const [reason, setReason] = useState("");

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/delivery-partner/${partner.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Action failed.");
      return;
    }
    setReasonMode(null);
    setReason("");
    router.refresh();
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-ink-900">{partner.fullName}</p>
          <p className="text-sm text-ink-500">
            {partner.mobile}
            {partner.email ? ` · ${partner.email}` : ""}
          </p>
          <p className="text-sm text-ink-500">
            {vehicleTypeLabel(partner.vehicleType)}
            {partner.vehicleRegistrationNumber ? ` · ${partner.vehicleRegistrationNumber}` : ""}
            {" · "}
            {partner.operatingRadiusKm} km radius
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <StatusBadge status={partner.status} />
            {partner.locationVerified ? <Badge tone="info">Map-verified</Badge> : null}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {partner.status === "REGISTERED" ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => act({ action: "start_review" })}>
              Start review
            </Button>
          ) : null}
          {(partner.status === "REGISTERED" || partner.status === "UNDER_REVIEW") ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => act({ action: "approve" })}>
                Approve
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setReasonMode("reject")}>
                Reject
              </Button>
            </>
          ) : null}
          {partner.status === "APPROVED" ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setReasonMode("suspend")}>
              Suspend
            </Button>
          ) : null}
          {partner.status === "SUSPENDED" ? (
            // TC-DEL-027: reactivating asks for a reason, like suspending.
            <Button size="sm" disabled={busy} onClick={() => setReasonMode("reactivate")}>
              Reactivate
            </Button>
          ) : null}
          {partner.status !== "DEACTIVATED" ? (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => setReasonMode("deactivate")}>
              Deactivate
            </Button>
          ) : null}
        </div>
      </div>

      {reasonMode ? (
        <div className="mt-3 flex gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={`Reason for ${reasonMode}`}
            className={inputClass}
          />
          <Button
            size="sm"
            variant={reasonMode === "reactivate" ? "primary" : "danger"}
            disabled={busy || reason.trim().length < 3}
            onClick={() => act({ action: reasonMode, reason })}
          >
            Confirm
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setReasonMode(null)}>
            Cancel
          </Button>
        </div>
      ) : null}

      {(partner.rejectionReason && (partner.status === "REJECTED" || partner.status === "SUSPENDED")) ? (
        <p className="mt-2 text-xs text-ink-500">Reason on file: {partner.rejectionReason}</p>
      ) : null}

      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-ink-900">{value}</p>
    </Card>
  );
}
