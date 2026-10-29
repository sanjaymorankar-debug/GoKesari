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
import { RecordPaymentForm } from "@/components/shop-finance-manager";
import {
  adminNextAction,
  reminderSentText,
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
  /** Of missingDocuments: never uploaded / waiting for a check / must be sent again. */
  notUploadedDocuments: string[];
  inReviewDocuments: string[];
  sendAgainDocuments: string[];
  /** Seller documents the owner has sent so far, any status. */
  documentsUploaded: number;
  feeOutstandingPaise: number;
  /** The owner ticked "I will provide all relevant documents within 30 days" (ISO times). */
  documentsPromisedAt: string | null;
  documentsDueAt: string | null;
}

const dueLabel = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(iso));

/** Owner decision 29 Oct 2026: a shop whose owner promised its documents waits for a person. */
function PromiseBadge({ shop }: { shop: AdminShop }) {
  if (!shop.documentsPromisedAt) return null;
  const due = shop.documentsDueAt ?? shop.documentsPromisedAt;
  const overdue = new Date(due).getTime() < Date.now();
  return (
    <Badge tone={overdue ? "danger" : "warning"}>
      {overdue ? "documents overdue since" : "documents promised by"} {dueLabel(due)}
    </Badge>
  );
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
  canWaiveDocuments = false,
  canRecordPayment = false,
  canWaiveFee = false,
  approvalGateOn = true,
}: {
  pending: AdminShop[];
  approved: AdminShop[];
  canApprove: boolean;
  canClassify: boolean;
  /** Admin only: approve a shop without its seller documents, with a reason. */
  canWaiveDocuments?: boolean;
  /** Record a registration-fee payment from the queue (PAYMENT_RECORD). */
  canRecordPayment?: boolean;
  /** Admin only: waive a pending shop's registration fee, with a reason. */
  canWaiveFee?: boolean;
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
              <PendingShopRow
                key={shop.id}
                shop={shop}
                canApprove={canApprove}
                canWaiveDocuments={canWaiveDocuments}
                canRecordPayment={canRecordPayment}
                canWaiveFee={canWaiveFee}
                approvalGateOn={approvalGateOn}
              />
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
  canWaiveDocuments,
  canRecordPayment,
  canWaiveFee,
  approvalGateOn,
}: {
  shop: AdminShop;
  canApprove: boolean;
  canWaiveDocuments: boolean;
  canRecordPayment: boolean;
  canWaiveFee: boolean;
  approvalGateOn: boolean;
}) {
  const stage = shop.onboardingStage;
  const next = stage ? adminNextAction({ stage, ...shop }) : null;
  const approveBlocked = approvalGateOn && stage !== "VERIFIED";
  const nothingUploaded = stage === "KYC_PENDING" && shop.documentsUploaded === 0;
  // Only what the owner has to send: documents waiting for our check are not theirs to chase.
  const canRemind = stage === "KYC_PENDING" && shop.notUploadedDocuments.length + shop.sendAgainDocuments.length > 0;
  const canWaive = canWaiveDocuments && approvalGateOn && stage === "KYC_PENDING";
  // An admin or operator approves a promised shop after inspecting it; the 1st / 15th reminders follow.
  const canAcceptPromise = approvalGateOn && stage === "KYC_PENDING" && shop.documentsPromisedAt !== null;
  const [acceptingPromise, setAcceptingPromise] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [waiving, setWaiving] = useState(false);
  const [waiveReason, setWaiveReason] = useState("");
  const feeDue = shop.feePaymentStatus !== "PAID";
  const outstandingPaise = Math.max(0, (shop.registrationFeePaise ?? 0) - shop.amountPaidPaise);
  const [feeAction, setFeeAction] = useState<"record" | "waive" | null>(null);
  const [feeReason, setFeeReason] = useState("");
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
    setNotice(null);
    const response = await fetch(`/api/shops/${shop.id}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setError(payload?.error?.message ?? "Action failed.");
      return null;
    }
    router.refresh();
    return payload;
  }

  async function remind() {
    const result = (await act("remind-documents", {})) as { sent: boolean; channels: string[] } | null;
    if (!result) return;
    setNotice(
      result.sent
        ? reminderSentText(shop.ownerName, result.channels)
        : `${shop.ownerName} was already reminded today. You can remind again tomorrow.`,
    );
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
            {nothingUploaded ? <Badge tone="danger">no documents uploaded</Badge> : null}
            <PromiseBadge shop={shop} />
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
            {feeDue && (canRecordPayment || canWaiveFee) ? (
              <div className="flex flex-wrap justify-end gap-2">
                {canRecordPayment ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setFeeAction((v) => (v === "record" ? null : "record"))}
                  >
                    Record fee payment
                  </Button>
                ) : null}
                {canWaiveFee && shop.amountPaidPaise === 0 ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setFeeAction((v) => (v === "waive" ? null : "waive"))}
                  >
                    Waive fee
                  </Button>
                ) : null}
              </div>
            ) : null}
            {canRemind || canWaive || canAcceptPromise ? (
              <div className="flex flex-wrap justify-end gap-2">
                {canAcceptPromise ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    data-testid="approve-on-promise"
                    onClick={() => setAcceptingPromise((v) => !v)}
                  >
                    Approve on promise
                  </Button>
                ) : null}
                {canRemind ? (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={remind}>
                    Remind owner to upload
                  </Button>
                ) : null}
                {canWaive ? (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => setWaiving((v) => !v)}>
                    Approve without documents
                  </Button>
                ) : null}
              </div>
            ) : null}
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

      {feeAction === "record" ? (
        <div className="mt-3 rounded-lg border border-cream-200 p-3">
          <p className="mb-2 text-sm text-ink-700">
            Record a registration-fee payment received for {shop.name} ({formatPaiseCompact(outstandingPaise)} outstanding).
          </p>
          <RecordPaymentForm
            shopId={shop.id}
            suggestedPaise={outstandingPaise}
            onDone={() => {
              setFeeAction(null);
              setNotice("Payment recorded.");
              router.refresh();
            }}
          />
        </div>
      ) : null}

      {feeAction === "waive" ? (
        <div className="mt-3 space-y-2 rounded-lg border border-cream-200 p-3">
          <p className="text-sm text-ink-700">
            Waive {shop.name}&apos;s registration fee of {formatPaiseCompact(outstandingPaise)}. The fee becomes zero and
            reads as settled; your name and reason are recorded. Other shops&apos; fees are not changed.
          </p>
          <div className="flex gap-2">
            <input
              value={feeReason}
              onChange={(e) => setFeeReason(e.target.value)}
              placeholder="Reason for waiving the fee"
              className={inputClass}
              aria-label="Reason for waiving the fee"
            />
            <Button
              size="sm"
              disabled={busy || feeReason.trim().length < 10}
              onClick={async () => {
                if (await act("waive-fee", { reason: feeReason })) {
                  setFeeAction(null);
                  setNotice("Registration fee waived.");
                }
              }}
            >
              Confirm waiver
            </Button>
          </div>
        </div>
      ) : null}

      {acceptingPromise ? (
        <div className="mt-3 space-y-2 rounded-lg border border-cream-200 p-3">
          <p className="text-sm text-ink-700">
            {shop.ownerName} promised to provide {shop.missingDocuments.join(", ") || "the missing documents"} by{" "}
            {dueLabel(shop.documentsDueAt ?? shop.documentsPromisedAt!)}. Approve {shop.name} as{" "}
            {classification === "KESARI" ? "Kesari" : "Green"} after inspecting it: the shop goes live now and your
            name is recorded. The owner is reminded on the 1st and 15th of each month, and the shop is suspended
            automatically if the documents are still missing after the third reminder. The registration fee and
            any licence the shop type needs (FSSAI for food) are still checked.
          </p>
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              if (await act("approve", { classification, acceptDocumentsPromise: true })) setAcceptingPromise(false);
            }}
          >
            Confirm approval
          </Button>
        </div>
      ) : null}

      {waiving ? (
        <div className="mt-3 space-y-2 rounded-lg border border-cream-200 p-3">
          <p className="text-sm text-ink-700">
            Approve {shop.name} as {classification === "KESARI" ? "Kesari" : "Green"} without verified documents (
            {shop.missingDocuments.join(", ")}). The shop goes live now; your name and reason are recorded. The
            registration fee and any licence the shop type needs are still checked.
          </p>
          <div className="flex gap-2">
            <input
              value={waiveReason}
              onChange={(e) => setWaiveReason(e.target.value)}
              placeholder="Reason for approving without documents"
              className={inputClass}
              aria-label="Reason for approving without documents"
            />
            <Button
              size="sm"
              disabled={busy || waiveReason.trim().length < 10}
              onClick={() => act("approve", { classification, waiveDocuments: { reason: waiveReason } })}
            >
              Confirm approval
            </Button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="mt-3">
          <Alert tone="success">{notice}</Alert>
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
