"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  ClassificationBadge,
  EmptyState,
  inputClass,
} from "@/components/ui";
import { formatPaiseCompact } from "@/lib/money";

export interface AdminShop {
  id: string;
  name: string;
  slug: string;
  ownerName: string;
  phone: string;
  city: string;
  area: string | null;
  pincode: string;
  shopType: string;
  status: string;
  classification: "KESARI" | "GREEN" | null;
  createdAt: string;
  feePaymentStatus: "PENDING" | "PARTIALLY_PAID" | "PAID" | "REFUNDED" | "CANCELLED";
  registrationFeePaise: number | null;
  amountPaidPaise: number;
}

/**
 * GS-008: approval is refused until the fee is settled, so the queue says where
 * each shop stands before the operator reaches for Approve.
 */
function FeeBadge({ shop }: { shop: AdminShop }) {
  if (shop.feePaymentStatus === "PAID") {
    return (
      <Badge tone="success">
        {(shop.registrationFeePaise ?? 0) === 0 ? "fee waived" : "fee paid"}
      </Badge>
    );
  }
  const outstanding = Math.max(0, (shop.registrationFeePaise ?? 0) - shop.amountPaidPaise);
  return (
    <Badge tone="danger">
      {shop.feePaymentStatus === "PARTIALLY_PAID"
        ? `fee part-paid · ${formatPaiseCompact(outstanding)} due`
        : shop.feePaymentStatus === "PENDING"
          ? `fee due · ${formatPaiseCompact(outstanding)}`
          : `fee ${shop.feePaymentStatus.toLowerCase()}`}
    </Badge>
  );
}

/** Shop approval queue and classification management (§8, §10, §42, §43). */
export function ShopApprovalPanel({
  pending,
  approved,
  canApprove,
  canClassify,
}: {
  pending: AdminShop[];
  approved: AdminShop[];
  canApprove: boolean;
  canClassify: boolean;
}) {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold text-ink-900">
          Pending approvals ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <EmptyState title="No shops waiting for approval." />
        ) : (
          <div className="space-y-3">
            {pending.map((shop) => (
              <PendingShopRow key={shop.id} shop={shop} canApprove={canApprove} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-ink-900">
          Approved shops ({approved.length})
        </h2>
        {approved.length === 0 ? (
          <EmptyState title="No approved shops yet." />
        ) : (
          <div className="space-y-2">
            {approved.map((shop) => (
              <ApprovedShopRow
                key={shop.id}
                shop={shop}
                canClassify={canClassify}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function PendingShopRow({
  shop,
  canApprove,
}: {
  shop: AdminShop;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [classification, setClassification] = useState<"KESARI" | "GREEN">(
    "GREEN",
  );
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  async function act(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/shops/${shop.id}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Action failed.");
      return;
    }
    router.refresh();
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-ink-900">{shop.name}</p>
          <p className="text-sm text-ink-500">
            {shop.ownerName} · {shop.phone}
          </p>
          <p className="text-sm text-ink-500">
            {[shop.area, shop.city].filter(Boolean).join(", ")} — {shop.pincode}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge>{shop.shopType}</Badge>
            <Badge tone="warning">pending</Badge>
            <FeeBadge shop={shop} />
          </div>
        </div>

        {canApprove ? (
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-ink-500" htmlFor={`cls-${shop.id}`}>
                Classify as
              </label>
              <select
                id={`cls-${shop.id}`}
                value={classification}
                onChange={(e) =>
                  setClassification(e.target.value as "KESARI" | "GREEN")
                }
                className="rounded-lg border border-cream-200 px-2 py-1.5 text-sm"
              >
                <option value="GREEN">Green</option>
                <option value="KESARI">Kesari</option>
              </select>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => act("approve", { classification })}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setRejecting((v) => !v)}
              >
                Reject
              </Button>
            </div>
          </div>
        ) : (
          <Badge>View only</Badge>
        )}
      </div>

      {rejecting ? (
        <div className="mt-3 flex gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for rejection"
            className={inputClass}
          />
          <Button
            size="sm"
            variant="danger"
            disabled={busy || reason.trim().length < 3}
            onClick={() => act("reject", { reason })}
          >
            Confirm
          </Button>
        </div>
      ) : null}

      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}

function ApprovedShopRow({
  shop,
  canClassify,
}: {
  shop: AdminShop;
  canClassify: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const next = shop.classification === "KESARI" ? "GREEN" : "KESARI";

  async function change() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/shops/${shop.id}/classification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classification: next, reason }),
    });
    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not change classification.");
      return;
    }
    setOpen(false);
    setReason("");
    router.refresh();
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link
            href={`/shops/${shop.slug}`}
            className="font-medium text-ink-900 hover:underline"
          >
            {shop.name}
          </Link>
          <ClassificationBadge value={shop.classification} />
          <Badge>{shop.shopType}</Badge>
          <span className="text-sm text-ink-500">
            {[shop.area, shop.city].filter(Boolean).join(", ")}
          </span>
        </div>

        {canClassify ? (
          <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)}>
            Change to {next === "KESARI" ? "Kesari" : "Green"}
          </Button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-3">
          <div className="flex gap-2">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason for the change (recorded in history)"
              className={inputClass}
            />
            <Button
              size="sm"
              disabled={busy || reason.trim().length < 3}
              onClick={change}
            >
              Save
            </Button>
          </div>
          <p className="mt-1 text-xs text-ink-500">
            Every classification change is recorded with who changed it, when and
            why.
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}
