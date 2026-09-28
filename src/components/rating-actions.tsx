"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

function Stars({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <span role="radiogroup" aria-label={label} className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          onClick={() => onChange(n)}
          className={`text-xl leading-none ${n <= value ? "text-kesari-500" : "text-cream-300"}`}
        >
          ★
        </button>
      ))}
    </span>
  );
}

/**
 * Rate a delivered order: the shop, and the rider when a platform rider
 * delivered it (GS-059/060). Server re-checks eligibility and duplicates.
 */
export function RateOrderForm({
  orderId,
  canRateShop,
  canRateRider,
  shopScore,
  riderScore,
}: {
  orderId: string;
  canRateShop: boolean;
  canRateRider: boolean;
  shopScore: number | null;
  riderScore: number | null;
}) {
  const router = useRouter();
  const [shop, setShop] = useState(0);
  const [rider, setRider] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const posts: Promise<Response>[] = [];
      if (canRateShop && shop > 0) {
        posts.push(
          fetch(`/api/orders/${orderId}/rating`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target: "SHOP", score: shop, comment: comment.trim() || null }),
          }),
        );
      }
      if (canRateRider && rider > 0) {
        posts.push(
          fetch(`/api/orders/${orderId}/rating`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target: "DELIVERY_PARTNER", score: rider }),
          }),
        );
      }
      for (const response of await Promise.all(posts)) {
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error?.message ?? "Your rating could not be saved.");
        }
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your rating could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const done = !canRateShop && !canRateRider;
  return (
    <div className="mt-3 border-t border-cream-100 pt-3 text-sm" data-testid="rate-order">
      {shopScore != null || riderScore != null ? (
        <p className="text-xs text-ink-500">
          You rated{shopScore != null ? ` the shop ${shopScore}★` : ""}
          {riderScore != null ? `${shopScore != null ? " and" : ""} the rider ${riderScore}★` : ""}. Thank you!
        </p>
      ) : null}
      {done ? null : (
        <div className="mt-1 space-y-2">
          {canRateShop ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 text-ink-600">Shop</span>
              <Stars value={shop} onChange={setShop} label="Rate the shop" />
            </div>
          ) : null}
          {canRateRider ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 text-ink-600">Delivery</span>
              <Stars value={rider} onChange={setRider} label="Rate the delivery" />
            </div>
          ) : null}
          {canRateShop ? (
            <input
              className={inputClass}
              maxLength={500}
              placeholder="Anything to add about the shop? (optional)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              aria-label="Review"
            />
          ) : null}
          <Button size="sm" disabled={busy || (shop === 0 && rider === 0)} onClick={submit}>
            Submit rating
          </Button>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
      )}
    </div>
  );
}

/** Report a problem with an order — creates a ticket linked to it (GS-056 / WF-007). */
export function ReportIssueForm({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<"ORDER" | "PRODUCT" | "PAYMENT">("PRODUCT");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/orders/${orderId}/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, description }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) {
      setError(payload?.error?.message ?? "Could not send your report.");
      return;
    }
    setResult(payload.ticketNumber);
    setOpen(false);
  }

  if (result) return <p className="mt-2 text-xs text-leaf-700">Reported — ticket {result}. We will get back to you.</p>;
  return (
    <div className="mt-2 text-sm">
      {open ? (
        <div className="space-y-2">
          <select
            className="rounded-lg border border-cream-200 px-2 py-1 text-sm"
            value={category}
            onChange={(e) => setCategory(e.target.value as typeof category)}
            aria-label="Problem type"
          >
            <option value="PRODUCT">Wrong / damaged / missing item</option>
            <option value="ORDER">Delivery problem</option>
            <option value="PAYMENT">Payment or refund</option>
          </select>
          <textarea
            className={inputClass}
            rows={2}
            maxLength={2000}
            placeholder="What went wrong? (at least 10 characters)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-label="Describe the problem"
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || description.trim().length < 10} onClick={submit}>
              Send
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
      ) : (
        <button type="button" className="text-xs font-medium text-kesari-700 underline" onClick={() => setOpen(true)}>
          Report a problem
        </button>
      )}
    </div>
  );
}

/** Operations: hide or restore a rating. */
export function ModerateRatingButton({ ratingId, hidden }: { ratingId: string; hidden: boolean }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/ratings/${ratingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hide: !hidden, reason }),
    });
    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Failed");
      return;
    }
    router.refresh();
  }
  return (
    <span className="flex items-center gap-2">
      {!hidden ? (
        <input
          className="w-40 rounded-lg border border-cream-200 px-2 py-1 text-xs"
          placeholder="Reason to hide"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Reason"
        />
      ) : null}
      <Button size="sm" variant="ghost" disabled={busy || (!hidden && reason.trim().length < 3)} onClick={act}>
        {hidden ? "Restore" : "Hide"}
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

/** Read-only star display, e.g. "4.3 ★ (12)". */
export function RatingBadge({ avgX100, count }: { avgX100: number; count: number }) {
  if (count === 0) return <span className="text-xs text-ink-400">No ratings yet</span>;
  return (
    <span className="text-xs font-medium text-ink-700" aria-label={`Rated ${(avgX100 / 100).toFixed(1)} out of 5 from ${count} ratings`}>
      {(avgX100 / 100).toFixed(1)} <span className="text-kesari-500">★</span> ({count})
    </span>
  );
}
