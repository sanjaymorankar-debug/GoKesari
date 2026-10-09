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
import {
  adminNextAction,
  ONBOARDING_STAGE_LABELS,
  ONBOARDING_STAGE_TONES,
  SHOP_ONBOARDING_STAGES,
  type ShopOnboardingStage,
} from "@/lib/shop-onboarding";

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
  /** SM-002 stage while awaiting approval; null for shops past onboarding. */
  onboardingStage: ShopOnboardingStage | null;
  missingDocuments: string[];
  feeOutstandingPaise: number;
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
/** SM-002: one badge per onboarding stage. */
export function OnboardingStageBadge({ stage }: { stage: ShopOnboardingStage }) {
  return <Badge tone={ONBOARDING_STAGE_TONES[stage]}>{ONBOARDING_STAGE_LABELS[stage]}</Badge>;
}

export function ShopApprovalPanel({
  pending,
  approved,
  canApprove,
  canClassify,
  approvalGateOn = true,
}: {
  pending: AdminShop[];
  approved: AdminShop[];
  canApprove: boolean;
  canClassify: boolean;
  /** statusModels.enforceTransitions — when off, Approve is offered at any stage. */
  approvalGateOn?: boolean;
}) {
  const [filter, setFilter] = useState<ShopOnboardingStage | "ALL">("ALL");
  const counts = Object.fromEntries(
    SHOP_ONBOARDING_STAGES.map((s) => [s, pending.filter((p) => p.onboardingStage === s).length]),
  ) as Record<ShopOnboardingStage, number>;
  const shown = filter === "ALL" ? pending : pending.filter((p) => p.onboardingStage === filter);
  return (
    <div className="space-y-8">
      <section id="shop-approvals">
        <h2 className="mb-3 text-lg font-semibold text-ink-900">
          Pending approvals ({pending.length})
        </h2>
        <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="Filter by onboarding stage">
          {(["ALL", ...SHOP_ONBOARDING_STAGES] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              onClick={() => setFilter(key)}
              className={
                filter === key
                  ? "rounded-full bg-kesari-600 px-3 py-1 text-xs font-medium text-white"
                  : "rounded-full border border-cream-200 px-3 py-1 text-xs text-ink-700 hover:bg-cream-100"
              }
            >
              {key === "ALL" ? `All (${pending.length})` : `${ONBOARDING_STAGE_LABELS[key]} (${counts[key]})`}
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <EmptyState title={filter === "ALL" ? "No shops waiting for approval." : "No shops at this stage."} />
        ) : (
          <div className="space-y-3">
            {shown.map((shop) => (
              <PendingShopRow key={shop.id} shop={shop} canApprove={canApprove} approvalGateOn={approvalGateOn} />
            ))}
          </div>
        )}
      </section>

      <section id="approved-shops">
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
  approvalGateOn,
}: {
  shop: AdminShop;
  canApprove: boolean;
  approvalGateOn: boolean;
}) {
  const stage = shop.onboardingStage;
  const next = stage
    ? adminNextAction({ stage, missingDocuments: shop.missingDocuments, feeOutstandingPaise: shop.feeOutstandingPaise })
    : null;
  const approveBlocked = approvalGateOn && stage !== "VERIFIED";
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
            {stage ? <OnboardingStageBadge stage={stage} /> : <Badge tone="warning">pending</Badge>}
            <FeeBadge shop={shop} />
          </div>
          {next ? (
            <p className="mt-2 text-sm text-ink-700" data-testid="onboarding-next-action">
              <span className="font-medium">Next: </span>
              {next.text}{" "}
              {stage !== "VERIFIED" ? (
                <Link href={next.href} className="font-medium text-kesari-600 hover:underline">
                  {next.linkLabel} →
                </Link>
              ) : null}
            </p>
          ) : null}
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
                disabled={busy || approveBlocked}
                title={approveBlocked ? "Only a verified shop can be approved" : undefined}
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
