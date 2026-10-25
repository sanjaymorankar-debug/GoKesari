"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

export type ShopOpenState = "OPEN" | "PAUSED" | "LAPSED" | "CLOSED" | "SUSPENDED" | "PENDING";

export interface ShopStatusView {
  shopId: string;
  shopName: string;
  state: ShopOpenState;
  /** Formatted on the server ("25 Oct 2026"). */
  closedOn: string | null;
  membership: { state: "NONE" | "ACTIVE" | "DUE_SOON" | "GRACE" | "LAPSED"; validUntil: string | null; offlineFrom: string | null };
}

const STATE_TEXT: Record<ShopOpenState, { label: string; tone: "success" | "warning" | "danger" | "info"; text: string }> = {
  OPEN: { label: "Open", tone: "success", text: "Customers can order online, within your opening hours." },
  LAPSED: { label: "Not online", tone: "danger", text: "Customers can't order until your membership is renewed." },
  PAUSED: { label: "Closed for now", tone: "warning", text: "Customers still see your shop but can't order online until you open it again." },
  CLOSED: { label: "Closed permanently", tone: "danger", text: "Your shop is off GoKesari. To reopen it, contact GoKesari support." },
  SUSPENDED: { label: "Suspended", tone: "danger", text: "GoKesari has suspended this shop. See Today's work for what to do." },
  PENDING: { label: "Not live yet", tone: "info", text: "Your shop opens to customers once it is approved." },
};

/**
 * D-69: open the shop or close it for now, see the membership, and close the
 * shop permanently. Opening hours (below on the same page) still decide
 * when an open shop takes orders.
 */
export function ShopStatusPanel({ view }: { view: ShopStatusView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const s = STATE_TEXT[view.state];
  const m = view.membership;

  async function send(url: string, method: "PATCH" | "POST", body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setError(payload?.error?.message ?? "That did not work. Please try again.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("That did not work. Please check your connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-4" data-testid="shop-status-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-ink-900">Shop status</h2>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <p className="text-sm text-ink-600">
        {s.text}
        {view.state === "CLOSED" && view.closedOn ? ` Closed on ${view.closedOn}.` : null}
      </p>

      {view.state === "OPEN" || view.state === "LAPSED" || view.state === "PAUSED" ? (
        <div className="flex flex-wrap gap-2">
          {view.state !== "PAUSED" ? (
            <Button variant="secondary" disabled={busy} onClick={() => send(`/api/shops/${view.shopId}`, "PATCH", { ordersPaused: true })}>
              Close shop for now
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => send(`/api/shops/${view.shopId}`, "PATCH", { ordersPaused: false })}>
              Open shop
            </Button>
          )}
        </div>
      ) : null}

      {m.state === "ACTIVE" ? <p className="text-sm text-ink-600">Membership valid until {m.validUntil}.</p> : null}
      {m.state === "DUE_SOON" ? (
        <Alert tone="warning">
          Your membership ends on {m.validUntil}. <Link href="/shop/manage/registration" className="font-medium underline">Renew it</Link> to stay online.
        </Alert>
      ) : null}
      {m.state === "GRACE" ? (
        <Alert tone="warning">
          Your membership ended on {m.validUntil}. <Link href="/shop/manage/registration" className="font-medium underline">Renew it</Link> before{" "}
          {m.offlineFrom}, or customers won&apos;t be able to order from your shop.
        </Alert>
      ) : null}
      {m.state === "LAPSED" ? (
        <Alert tone="danger">
          Your membership ended on {m.validUntil}, so your shop is not online. <Link href="/shop/manage/registration" className="font-medium underline">Renew it</Link> to
          take orders again.
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {view.state !== "CLOSED" ? (
        <div className="border-t border-cream-200 pt-4">
          {!closing ? (
            <Button variant="ghost" className="text-red-700" onClick={() => setClosing(true)}>
              Close shop permanently
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-ink-700">
                Closing permanently takes your shop off GoKesari. Deliver or cancel your open orders first; customers&apos; subscriptions to your shop are cancelled and they are told.
                Money you are owed is still paid out. Only GoKesari support can reopen the shop.
              </p>
              <Field label="Why are you closing?">
                <textarea className={inputClass} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <Field label={`Type the shop's name (${view.shopName}) to confirm`}>
                <input className={inputClass} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  disabled={busy || reason.trim().length < 5 || confirmName.trim().toLowerCase() !== view.shopName.trim().toLowerCase()}
                  onClick={async () => {
                    if (await send(`/api/shops/${view.shopId}/close`, "POST", { reason: reason.trim(), confirmName })) setClosing(false);
                  }}
                >
                  {busy ? "Closing…" : "Close permanently"}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setClosing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
}
