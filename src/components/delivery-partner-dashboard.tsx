"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useState } from "react";

import { Alert, Button, Card, Money } from "@/components/ui";
import { formatScheduledSlot } from "@/lib/scheduled-slots";
import { shrinkImage } from "@/components/image-uploader";

export interface ActiveDelivery {
  id: string;
  status: string;
  orderNumber: string;
  orderTotalPaise: number;
  /** Cash on delivery: the amount to collect at the door (null when prepaid). */
  cashToCollectPaise: number | null;
  /** GS-027: deliver within this slot (the customer's chosen time). */
  scheduledSlot?: { start: string; end: string } | null;
  /** NEW-007: a photo at the door is needed before "Mark delivered". */
  proofRequired?: boolean;
  proofUploaded?: boolean;
  shopName: string;
  shopAddress: string;
  customerAddress: string | null;
  distanceKm: string | null;
  /** F4: estimated minutes to ride to the shop / shop → customer; ROAD when from a routing service. */
  pickupDurationSeconds?: number | null;
  legDurationSeconds?: number | null;
  routeSource?: "ROAD" | "STRAIGHT_LINE" | null;
  /** The shop must give the rider a pickup code (Slice 4). */
  needsPickupCode: boolean;
  /** The customer must give the rider a delivery code. */
  needsDeliveryOtp: boolean;
  /** Set once the rider has left the shop for the customer. */
  outForDeliveryAt: Date | string | null;
  /** Landmark / customer's delivery instructions. */
  customerNotes: string | null;
  /** Society gate / parking notes, for society deliveries. */
  societyName: string | null;
  societyInstructions: string | null;
  acceptedAt?: Date | string | null;
  arrivedAtShopAt?: Date | string | null;
  pickedUpAt?: Date | string | null;
  arrivedAtCustomerAt?: Date | string | null;
  /** Where to collect and drop, with a maps deep link; the drop is coarse until pickup. */
  pickup?: { label: string; navigationUrl: string | null; notes: string | null };
  drop?: { label: string; navigationUrl: string | null; notes: string | null; precise: boolean };
  /** Society gate arrangement, for society deliveries. */
  gate?: { entryMode: string; contactName: string | null; contactPhone: string | null } | null;
}

const GATE_MODE_LABEL: Record<string, string> = {
  OPEN: "Open entry",
  CALL_RESIDENT: "Security calls the resident before letting you in",
  PRE_APPROVAL: "Resident pre-approves the rider at the gate",
  DROP_AT_GATE: "Hand the order over at the gate",
};

/** The five checkpoints a rider moves through, with what has been reached. */
function ProgressSteps({ delivery }: { delivery: ActiveDelivery }) {
  const steps: { label: string; done: boolean }[] = [
    { label: "Accepted", done: Boolean(delivery.acceptedAt) || delivery.status !== "OFFERED" },
    { label: "At the shop", done: Boolean(delivery.arrivedAtShopAt) || delivery.status === "PICKED_UP" },
    { label: "Picked up", done: delivery.status === "PICKED_UP" },
    { label: "On the way", done: Boolean(delivery.outForDeliveryAt) },
    { label: "At the customer", done: Boolean(delivery.arrivedAtCustomerAt) },
  ];
  return (
    <ol className="mt-3 flex flex-wrap gap-1 text-xs" aria-label="Delivery progress" data-testid="delivery-progress">
      {steps.map((step) => (
        <li
          key={step.label}
          className={`rounded-full px-2 py-0.5 ${step.done ? "bg-leaf-100 text-leaf-800" : "bg-cream-100 text-ink-500"}`}
        >
          {step.done ? "✓ " : ""}
          {step.label}
        </li>
      ))}
    </ol>
  );
}

export interface ActiveReturnPickupView {
  id: string;
  status: string;
  returnNumber: string;
  scheduledFor: Date | string | null;
  needsHandoverCode: boolean;
  shopName: string;
  shopAddress: string;
  itemSummary: string;
  customerAddress: string | null;
  customerNotes: string | null;
  navigationUrl: string | null;
  shopNavigationUrl: string | null;
}

export interface EarningsSummary {
  todayPaise: number;
  totalPaise: number;
  deliveryCount: number;
}

export interface RiderRating {
  avgX100: number;
  count: number;
}

const STATUS_LABEL: Record<string, string> = {
  OFFERED: "New delivery offer — accept within 2 minutes",
  ACCEPTED: "Accepted — head to the shop and ask for the pickup code",
  PICKED_UP: "Picked up — deliver to the customer",
};

// Customers poll tracking every 15s; idle riders only need to be fresh enough for dispatch.
const HEARTBEAT_ON_DELIVERY_MS = 15_000;
const HEARTBEAT_IDLE_MS = 60_000;
/** Live tracking: once the drop starts; the server's `nextPingSeconds` (rule tracking.riderPingSeconds) replaces it. */
const TRACKING_PING_DEFAULT_MS = 5_000;
// Checked every second so a 5-second cadence is kept, not rounded up to the next tick.
const HEARTBEAT_TICK_MS = 1_000;
const RIDER_LOCATION_URL = "/api/delivery-partner/location";

interface LocationReply {
  shared?: boolean;
  /** Live tracking endpoint only: false once the drop is over — nothing more is stored. */
  sharing?: boolean;
  nextPingSeconds?: number;
}
const MAX_FIX_AGE_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const LOCATION_TIMEOUT_MS = 20_000;
// Outlasts the geolocation timeout, for browsers that never call either callback (Firefox "Not now").
const GO_ONLINE_WATCHDOG_MS = LOCATION_TIMEOUT_MS + 10_000;

type LocationIssue = "blocked" | "unauthorized" | "unavailable" | null;

interface Fix {
  latitude: number;
  longitude: number;
  receivedAt: number;
  receivedWallAt: number;
}

function isStale(fix: Fix): boolean {
  // performance.now() pauses while some phones sleep, so the wall-clock receipt time is a second bound.
  return performance.now() - fix.receivedAt > MAX_FIX_AGE_MS || Date.now() - fix.receivedWallAt > MAX_FIX_AGE_MS;
}

/**
 * Posts the rider's position while online: to /api/delivery-partner/location
 * (for matching), or — once a drop has started — to that delivery's live
 * tracking endpoint. The server ignores it if the rider is offline, so this
 * never writes location outside an online session.
 */
function useLocationHeartbeat(
  enabled: boolean,
  intervalMs: number,
  onServerOffline: () => void,
  endpoint: string = RIDER_LOCATION_URL,
  onReply?: (reply: LocationReply) => void,
): LocationIssue {
  const [blocked, setBlocked] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [arm, setArm] = useState(0);
  const serverOffline = useEffectEvent(onServerOffline);
  const replied = useEffectEvent((reply: LocationReply) => onReply?.(reply));

  // Alerts from a previous online stretch must not resurface when the rider goes online again.
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (!enabled) {
      setBlocked(false);
      setUnauthorized(false);
      setUnavailable(false);
    }
  }

  useEffect(() => {
    if (!enabled || !("geolocation" in navigator)) return;
    const geo = navigator.geolocation;
    let latest: Fix | null = null;
    let lastSentAt = -Infinity;
    let inFlight: AbortController | null = null;
    let refreshing = false;
    let denied = false;
    let disposed = false;
    let permission: PermissionStatus | null = null;
    // When errors started with no fix in between; performance.now() pauses in sleep, so a wake-up never counts as a gap.
    let failingSince: number | null = null;

    function remember(position: GeolocationPosition) {
      latest = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        receivedAt: performance.now(),
        receivedWallAt: Date.now(),
      };
      failingSince = null;
      setBlocked(false);
      setUnavailable(false);
    }

    function fail(err: GeolocationPositionError) {
      if (err.code === err.PERMISSION_DENIED) {
        denied = true;
        setBlocked(true);
        return;
      }
      // POSITION_UNAVAILABLE / TIMEOUT: device location off, or no fix indoors. Tell the rider once it has lasted.
      const now = performance.now();
      if (failingSince === null) failingSince = now;
      if (now - failingSince >= MAX_FIX_AGE_MS) setUnavailable(true);
    }

    // Some providers only report on movement, so a stationary rider needs an explicit fresh fix.
    function refresh() {
      if (refreshing || denied) return;
      refreshing = true;
      try {
        geo.getCurrentPosition(
          (position) => {
            refreshing = false;
            if (disposed) return;
            remember(position);
            sendIfDue();
          },
          (err) => {
            refreshing = false;
            if (!disposed) fail(err);
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: LOCATION_TIMEOUT_MS },
        );
      } catch {
        // A synchronous throw (embedded WebView, Permissions-Policy) will not clear on retry; surface it as blocked.
        refreshing = false;
        denied = true;
        if (!disposed) setBlocked(true);
      }
    }

    function sendIfDue() {
      if (disposed || inFlight || performance.now() - lastSentAt < intervalMs) return;
      if (!latest || isStale(latest)) {
        refresh();
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      inFlight = controller;
      lastSentAt = performance.now();
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude: latest.latitude, longitude: latest.longitude }),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (disposed) return;
          if (response.status === 401 || response.status === 403) {
            setUnauthorized(true);
            return;
          }
          if (!response.ok) return;
          setUnauthorized(false);
          const body: unknown = await response.json();
          if (disposed || typeof body !== "object" || body === null) return;
          const reply = body as LocationReply;
          if (reply.shared === false) serverOffline();
          else replied(reply);
        })
        .catch(() => {})
        .finally(() => {
          clearTimeout(timeout);
          if (inFlight === controller) inFlight = null;
        });
    }

    // A denial kills the watch; re-arm once the rider allows location again (Safari never fires this — hence Reload).
    function onPermissionChange() {
      if (!denied || permission?.state === "denied") return;
      setBlocked(false);
      setArm((n) => n + 1);
    }
    if ("permissions" in navigator) {
      navigator.permissions.query({ name: "geolocation" }).then(
        (status) => {
          if (disposed) return;
          permission = status;
          status.addEventListener("change", onPermissionChange);
        },
        () => {},
      );
    }

    let watchId: number | null = null;
    try {
      watchId = geo.watchPosition(
        (position) => {
          remember(position);
          sendIfDue();
        },
        fail,
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
      );
    } catch {
      // Left unarmed: the first tick's refresh() hits the same failure and raises the blocked alert.
    }
    const timer = setInterval(sendIfDue, HEARTBEAT_TICK_MS);

    return () => {
      disposed = true;
      if (watchId !== null) geo.clearWatch(watchId);
      clearInterval(timer);
      inFlight?.abort();
      permission?.removeEventListener("change", onPermissionChange);
    };
  }, [enabled, intervalMs, arm, endpoint]);

  if (!enabled) return null;
  if (blocked) return "blocked";
  if (unauthorized) return "unauthorized";
  return unavailable ? "unavailable" : null;
}

/** 4-digit code entry for pickup/delivery handover. */
function CodeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      className="w-40 rounded-lg border border-cream-200 px-3 py-2 text-sm tracking-widest"
      inputMode="numeric"
      maxLength={4}
      placeholder={label}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
    />
  );
}

/**
 * Online/offline toggle, active delivery actions, earnings summary
 * (delivery-system Part 58, Slice C). Location comes only from the
 * browser's native geolocation — never a Google Maps Platform call.
 */
export function DeliveryPartnerDashboard({
  isOnline: initialOnline,
  activeDelivery,
  activeReturnPickup = null,
  earnings,
  rating,
}: {
  isOnline: boolean;
  activeDelivery: ActiveDelivery | null;
  /** A customer return the rider is collecting (goods go back to the shop). */
  activeReturnPickup?: ActiveReturnPickupView | null;
  earnings: EarningsSummary;
  /** The rider's own average (GS-060), shown only to them. */
  rating?: RiderRating;
}) {
  const router = useRouter();
  const [isOnline, setIsOnline] = useState(initialOnline);
  const [serverOnline, setServerOnline] = useState(initialOnline);
  if (serverOnline !== initialOnline) {
    setServerOnline(initialOnline);
    setIsOnline(initialOnline);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [failReason, setFailReason] = useState("");
  const [showFail, setShowFail] = useState(false);
  const [cashCollected, setCashCollected] = useState(false);
  const onDelivery = activeDelivery?.status === "PICKED_UP";
  // Live tracking: from the start of the drop the customer can follow the rider.
  const dropStarted = onDelivery && Boolean(activeDelivery?.outForDeliveryAt);
  const [trackingPingMs, setTrackingPingMs] = useState(TRACKING_PING_DEFAULT_MS);
  const locationIssue = useLocationHeartbeat(
    isOnline,
    dropStarted ? trackingPingMs : onDelivery ? HEARTBEAT_ON_DELIVERY_MS : HEARTBEAT_IDLE_MS,
    () => {
      setIsOnline(false);
      router.refresh();
    },
    dropStarted && activeDelivery ? `/api/delivery-orders/${activeDelivery.id}/location` : RIDER_LOCATION_URL,
    (reply) => {
      if (typeof reply.nextPingSeconds === "number" && reply.nextPingSeconds * 1000 !== trackingPingMs) {
        setTrackingPingMs(reply.nextPingSeconds * 1000);
      }
      // The drop is over (delivered or cancelled elsewhere): stop sharing and reload the job.
      if (reply.sharing === false) router.refresh();
    },
  );

  async function setStatus(body: Record<string, string | number>, fallback: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch("/api/delivery-partner/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.ok) return true;
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? fallback);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      // The change may have committed before the response was lost; re-read the real online flag.
      router.refresh();
    } finally {
      clearTimeout(timeout);
    }
    return false;
  }

  async function toggleOnline() {
    setError(null);
    if (isOnline) {
      setBusy(true);
      try {
        if (!(await setStatus({ action: "offline" }, "Could not go offline. Try again."))) return;
        setIsOnline(false);
        router.refresh();
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!("geolocation" in navigator)) {
      setError("Your browser does not support location — cannot go online.");
      return;
    }
    setBusy(true);
    // A late callback after the watchdog fired must not submit the PATCH behind the rider's back.
    let settled = false;
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      setBusy(false);
      setError("Could not get your location. Try again.");
    }, GO_ONLINE_WATCHDOG_MS);
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(watchdog);
      return true;
    };
    try {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          if (!settle()) return;
          try {
            const online = await setStatus(
              { action: "online", latitude: position.coords.latitude, longitude: position.coords.longitude },
              "Could not go online.",
            );
            if (!online) return;
            setIsOnline(true);
            router.refresh();
          } finally {
            setBusy(false);
          }
        },
        (err) => {
          if (!settle()) return;
          setBusy(false);
          setError(
            err.code === err.PERMISSION_DENIED
              ? "Location permission is required to go online."
              : "Could not get your location. Try again.",
          );
        },
        { timeout: LOCATION_TIMEOUT_MS },
      );
    } catch {
      if (!settle()) return;
      setBusy(false);
      setError("Could not get your location. Try again.");
    }
  }

  async function act(
    action: "accept" | "reject" | "arrived_shop" | "pickup" | "start" | "arrived_customer" | "deliver" | "fail",
    extra: Record<string, string | boolean> = {},
  ) {
    if (!activeDelivery) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/delivery-orders/${activeDelivery.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? "Action failed.");
        return;
      }
      setCode("");
      setFailReason("");
      setShowFail(false);
      setCashCollected(false);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="flex items-center justify-between p-5">
        <div>
          <p className="font-semibold text-ink-900">{isOnline ? "You're online" : "You're offline"}</p>
          <p className="text-sm text-ink-500">
            {isOnline ? "You may be offered nearby deliveries." : "Go online to start receiving deliveries."}
          </p>
        </div>
        <Button
          variant={isOnline ? "secondary" : "primary"}
          disabled={busy || (!!activeDelivery && isOnline)}
          onClick={toggleOnline}
        >
          {isOnline ? "Go offline" : "Go online"}
        </Button>
      </Card>

      {locationIssue === "blocked" ? (
        <Alert tone="warning" title="Location is blocked">
          <p>
            Nearby offers and live tracking for customers won&apos;t work. Allow location for this site in your
            browser settings, then reload this page.
          </p>
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </Alert>
      ) : null}
      {locationIssue === "unauthorized" ? (
        <Alert tone="warning" title="Your location isn't being shared">
          Switch to your Delivery Partner role from the &ldquo;Acting as&rdquo; menu at the top of the page, or sign
          in again.
        </Alert>
      ) : null}
      {locationIssue === "unavailable" ? (
        <Alert tone="warning" title="We can't read your location">
          Nearby offers and live tracking for customers won&apos;t work until we can. Turn on location services for
          your device, or move somewhere with a clearer signal.
        </Alert>
      ) : null}

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-4">
          <p className="text-xs text-ink-500">Today</p>
          <p className="mt-1 text-lg font-bold text-ink-900">
            <Money paise={earnings.todayPaise} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Total earned</p>
          <p className="mt-1 text-lg font-bold text-ink-900">
            <Money paise={earnings.totalPaise} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Deliveries</p>
          <p className="mt-1 text-lg font-bold text-ink-900">{earnings.deliveryCount}</p>
          {rating && rating.count > 0 ? (
            <p className="text-xs text-ink-500">
              {(rating.avgX100 / 100).toFixed(1)}★ from {rating.count}
            </p>
          ) : null}
        </Card>
      </div>

      {activeDelivery ? (
        <Card className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-kesari-600">
            {STATUS_LABEL[activeDelivery.status] ?? activeDelivery.status}
          </p>
          <p className="mt-2 font-semibold text-ink-900">{activeDelivery.orderNumber}</p>
          {activeDelivery.scheduledSlot ? (
            <p className="mt-1 text-sm font-medium text-kesari-700" data-testid="rider-scheduled-slot">
              Deliver {formatScheduledSlot(activeDelivery.scheduledSlot.start, activeDelivery.scheduledSlot.end)}
            </p>
          ) : null}
          {activeDelivery.status !== "OFFERED" ? <ProgressSteps delivery={activeDelivery} /> : null}
          <div className="mt-3 space-y-2 text-sm">
            <div>
              <p className="font-medium text-ink-700">Pickup</p>
              <p className="text-ink-500">{activeDelivery.shopName} — {activeDelivery.shopAddress}</p>
              {activeDelivery.pickup?.notes ? <p className="text-ink-500">Note: {activeDelivery.pickup.notes}</p> : null}
              {activeDelivery.pickup?.navigationUrl && activeDelivery.status !== "OFFERED" && activeDelivery.status !== "PICKED_UP" ? (
                <a
                  href={activeDelivery.pickup.navigationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-sm font-medium text-kesari-700 underline"
                  data-testid="navigate-pickup"
                >
                  Navigate to the shop
                </a>
              ) : null}
            </div>
            <div>
              <p className="font-medium text-ink-700">Drop</p>
              <p className="text-ink-500">{activeDelivery.customerAddress ?? "Address on order details"}</p>
              {activeDelivery.drop && !activeDelivery.drop.precise ? (
                <p className="text-xs text-ink-400">The full address and navigation appear once you pick up the order.</p>
              ) : null}
              {activeDelivery.customerNotes ? <p className="text-ink-500">Note: {activeDelivery.customerNotes}</p> : null}
              {activeDelivery.drop?.navigationUrl && activeDelivery.status === "PICKED_UP" ? (
                <a
                  href={activeDelivery.drop.navigationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-sm font-medium text-kesari-700 underline"
                  data-testid="navigate-drop"
                >
                  Navigate to the customer
                </a>
              ) : null}
            </div>
            {activeDelivery.societyName ? (
              <div className="rounded-lg bg-cream-100 p-2" data-testid="society-notes">
                <p className="font-medium text-ink-700">{activeDelivery.societyName}</p>
                {activeDelivery.gate ? (
                  <p className="text-ink-600">Gate: {GATE_MODE_LABEL[activeDelivery.gate.entryMode] ?? activeDelivery.gate.entryMode}</p>
                ) : null}
                {activeDelivery.societyInstructions ? (
                  <p className="text-ink-600">{activeDelivery.societyInstructions}</p>
                ) : null}
                {activeDelivery.gate?.contactPhone ? (
                  <p className="text-ink-600">
                    Security desk{activeDelivery.gate.contactName ? ` (${activeDelivery.gate.contactName})` : ""}:{" "}
                    <a href={`tel:${activeDelivery.gate.contactPhone}`} className="underline">
                      {activeDelivery.gate.contactPhone}
                    </a>
                  </p>
                ) : null}
              </div>
            ) : null}
            {activeDelivery.cashToCollectPaise != null ? (
              <p className="rounded-lg bg-kesari-50 p-2 font-semibold text-kesari-800" data-testid="cash-to-collect">
                Cash on delivery — collect <Money paise={activeDelivery.cashToCollectPaise} />
              </p>
            ) : null}
            {activeDelivery.distanceKm ? (
              <p className="text-ink-500">
                ~{Number(activeDelivery.distanceKm).toFixed(1)} km delivery leg
                {activeDelivery.routeSource === "ROAD" ? " by road" : ""}
              </p>
            ) : null}
            {activeDelivery.legDurationSeconds != null ? (
              <p className="text-ink-500" data-testid="rider-eta">
                {activeDelivery.pickupDurationSeconds != null && !activeDelivery.outForDeliveryAt
                  ? `About ${Math.max(1, Math.round(activeDelivery.pickupDurationSeconds / 60))} min to the shop, then `
                  : "About "}
                {Math.max(1, Math.round(activeDelivery.legDurationSeconds / 60))} min to the customer
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {activeDelivery.status === "OFFERED" ? (
              <>
                <Button size="sm" disabled={busy} onClick={() => act("accept")}>
                  Accept
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("reject")}>
                  Reject
                </Button>
              </>
            ) : null}
            {activeDelivery.status === "ACCEPTED" && !activeDelivery.arrivedAtShopAt ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("arrived_shop")}>
                I&apos;ve arrived at the shop
              </Button>
            ) : null}
            {activeDelivery.status === "ACCEPTED" ? (
              <>
                {activeDelivery.needsPickupCode ? (
                  <CodeInput
                    label="Pickup code from the shop"
                    value={code}
                    onChange={setCode}
                  />
                ) : null}
                <Button
                  size="sm"
                  disabled={busy || (activeDelivery.needsPickupCode && code.length !== 4)}
                  onClick={() => act("pickup", { pickupCode: code })}
                >
                  Confirm pickup
                </Button>
              </>
            ) : null}
            {activeDelivery.status === "PICKED_UP" &&
            activeDelivery.needsPickupCode &&
            !activeDelivery.outForDeliveryAt ? (
              <Button size="sm" disabled={busy} onClick={() => act("start")}>
                Start delivery
              </Button>
            ) : null}
            {activeDelivery.status === "PICKED_UP" &&
            (activeDelivery.outForDeliveryAt || !activeDelivery.needsPickupCode) &&
            !activeDelivery.arrivedAtCustomerAt ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("arrived_customer")}>
                I&apos;ve arrived at the customer
              </Button>
            ) : null}
            {activeDelivery.status === "PICKED_UP" &&
            (activeDelivery.outForDeliveryAt || !activeDelivery.needsPickupCode) ? (
              <>
                {activeDelivery.needsDeliveryOtp ? (
                  <CodeInput
                    label="Delivery code from the customer"
                    value={code}
                    onChange={setCode}
                  />
                ) : null}
                {activeDelivery.proofRequired ? (
                  <DeliveryProofCapture
                    deliveryOrderId={activeDelivery.id}
                    uploaded={Boolean(activeDelivery.proofUploaded)}
                  />
                ) : null}
                {activeDelivery.cashToCollectPaise != null ? (
                  <label className="flex items-center gap-2 text-sm text-ink-700">
                    <input
                      type="checkbox"
                      checked={cashCollected}
                      onChange={(e) => setCashCollected(e.target.checked)}
                    />
                    I collected <Money paise={activeDelivery.cashToCollectPaise} /> in cash
                  </label>
                ) : null}
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    (activeDelivery.needsDeliveryOtp && code.length !== 4) ||
                    (activeDelivery.cashToCollectPaise != null && !cashCollected) ||
                    (Boolean(activeDelivery.proofRequired) && !activeDelivery.proofUploaded)
                  }
                  onClick={() => act("deliver", { otp: code, cashCollected })}
                >
                  Mark delivered
                </Button>
              </>
            ) : null}
            {activeDelivery.status === "PICKED_UP" ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setShowFail((v) => !v)}>
                Could not deliver
              </Button>
            ) : null}
          </div>

          {showFail ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-sm"
                placeholder="What happened? e.g. customer not reachable"
                value={failReason}
                onChange={(e) => setFailReason(e.target.value)}
                aria-label="Reason the delivery failed"
              />
              <Button
                size="sm"
                variant="danger"
                disabled={busy || failReason.trim().length < 3}
                onClick={() => act("fail", { reason: failReason })}
              >
                Report failed delivery
              </Button>
            </div>
          ) : null}
        </Card>
      ) : isOnline ? (
        <Card className="p-5 text-sm text-ink-500">Waiting for a delivery offer…</Card>
      ) : null}

      {activeReturnPickup ? (
        <ReturnPickupPanel pickup={activeReturnPickup} onDone={() => router.refresh()} />
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}

const RETURN_PICKUP_LABEL: Record<string, string> = {
  OFFERED: "New return pickup — accept within the offer time",
  ACCEPTED: "Return pickup accepted — head to the customer when ready",
  EN_ROUTE: "On the way to the customer",
};

/** A rider's live return pickup: accept, set off, take the goods with the customer's code, or report a problem. */
function ReturnPickupPanel({ pickup, onDone }: { pickup: ActiveReturnPickupView; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [showFail, setShowFail] = useState(false);
  const [failReason, setFailReason] = useState("");

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/return-pickups/${pickup.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setError(payload?.error?.message ?? "Action failed.");
        return;
      }
      setCode("");
      setShowFail(false);
      onDone();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5" data-testid="return-pickup-panel">
      <p className="text-xs font-semibold uppercase tracking-wide text-kesari-600">
        {RETURN_PICKUP_LABEL[pickup.status] ?? pickup.status}
      </p>
      <p className="mt-2 font-semibold text-ink-900">Return {pickup.returnNumber}</p>
      <div className="mt-3 space-y-2 text-sm">
        <div>
          <p className="font-medium text-ink-700">Collect from</p>
          <p className="text-ink-500">{pickup.customerAddress ?? "Address on order details"}</p>
          {pickup.customerAddress && pickup.status !== "EN_ROUTE" ? (
            <p className="text-xs text-ink-400">The full address and navigation appear once you set off.</p>
          ) : null}
          {pickup.customerNotes ? <p className="text-ink-500">Note: {pickup.customerNotes}</p> : null}
          {pickup.scheduledFor ? (
            <p className="text-ink-500">
              Ready from {new Date(pickup.scheduledFor).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
            </p>
          ) : null}
          {pickup.navigationUrl ? (
            <a href={pickup.navigationUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-kesari-700 underline">
              Navigate to the customer
            </a>
          ) : null}
        </div>
        <div>
          <p className="font-medium text-ink-700">Bring back to</p>
          <p className="text-ink-500">
            {pickup.shopName} — {pickup.shopAddress}
          </p>
          {pickup.shopNavigationUrl ? (
            <a href={pickup.shopNavigationUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-kesari-700 underline">
              Navigate to the shop
            </a>
          ) : null}
        </div>
        <p className="text-ink-500">{pickup.itemSummary}</p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {pickup.status === "OFFERED" ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => act({ action: "accept" })}>
              Accept
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => act({ action: "reject" })}>
              Reject
            </Button>
          </>
        ) : null}
        {pickup.status === "ACCEPTED" ? (
          <Button size="sm" disabled={busy} onClick={() => act({ action: "start" })}>
            Set off to the customer
          </Button>
        ) : null}
        {pickup.status === "EN_ROUTE" ? (
          <>
            <CodeInput label="Handover code from the customer" value={code} onChange={setCode} />
            <Button size="sm" disabled={busy || code.length !== 4} onClick={() => act({ action: "pickup", code })}>
              Confirm pickup
            </Button>
          </>
        ) : null}
        {pickup.status === "ACCEPTED" || pickup.status === "EN_ROUTE" ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setShowFail((v) => !v)}>
            Could not collect
          </Button>
        ) : null}
      </div>

      {showFail ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-sm"
            placeholder="What happened? e.g. customer not home"
            value={failReason}
            onChange={(e) => setFailReason(e.target.value)}
            aria-label="Reason the pickup failed"
          />
          <Button
            size="sm"
            variant="danger"
            disabled={busy || failReason.trim().length < 3}
            onClick={() => act({ action: "fail", reason: failReason })}
          >
            Report failed pickup
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

/**
 * NEW-007: the photo at the door. Opens the camera on a phone; the image is
 * shrunk and re-encoded in the browser (which also drops location metadata)
 * and checked again on the server.
 */
function DeliveryProofCapture({ deliveryOrderId, uploaded }: { deliveryOrderId: string; uploaded: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", await shrinkImage(file), "delivery.jpg");
      const response = await fetch(`/api/delivery-orders/${deliveryOrderId}/proof`, { method: "POST", body });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? "Could not upload the photo.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not upload the photo. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1 text-sm" data-testid="delivery-proof">
      <label className="block font-medium text-ink-700">
        {uploaded ? "Photo at the door added ✓ — retake if needed" : "Photo of the order at the door (required)"}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          disabled={busy}
          onChange={(e) => void upload(e.target.files)}
          className="mt-1 block w-full text-xs"
        />
      </label>
      {busy ? <p className="text-xs text-ink-500">Uploading…</p> : null}
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
