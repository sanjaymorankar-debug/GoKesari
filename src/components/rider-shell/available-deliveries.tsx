"use client";

/**
 * Rider App v2 — Available Deliveries (rule riderJobBoard, works with or
 * without riderAppV2). Lists open jobs near an online, verified rider from
 * GET /api/delivery-partner/jobs, refreshing every pollSeconds while the tab
 * is visible (paused when hidden). Accept → POST …/jobs/accept (409 "Taken"
 * when another rider was first); Reject → reason picker → POST …/jobs/pass.
 * Shows only the rider's own pay and, on COD, the cash to collect.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, Badge, Button, Card, Money } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";
import type { RiderRejectReason } from "@/lib/rider-reject-reasons";
import type { JobBoard, RiderJob } from "@/server/services/rider-job-board";

import { YouEarn } from "./pay-breakdown";
import { RejectReasonPicker } from "./reject-reason-picker";

const T = {
  title: L("Available deliveries", "उपलब्ध डिलीवरी", "उपलब्ध डिलिव्हऱ्या"),
  none: L("No open deliveries near you right now. This list refreshes by itself.", "अभी आपके पास कोई खुली डिलीवरी नहीं है। यह सूची अपने-आप ताज़ा होती है।", "सध्या तुमच्याजवळ खुली डिलिव्हरी नाही. ही यादी आपोआप ताजी होते."),
  noLocation: L("We need your location to show deliveries near you.", "आस-पास की डिलीवरी दिखाने के लिए आपकी लोकेशन चाहिए।", "जवळच्या डिलिव्हऱ्या दाखवण्यासाठी तुमचे लोकेशन हवे."),
  pickup: L("Pickup {km} km", "पिकअप {km} km", "पिकअप {km} km"),
  drop: L("Delivery {km} km", "डिलीवरी {km} km", "डिलिव्हरी {km} km"),
  total: L("Total {km} km", "कुल {km} km", "एकूण {km} km"),
  eta: L("~{n} min", "~{n} मिनट", "~{n} मिनिटे"),
  items: L("{n} items", "{n} सामान", "{n} वस्तू"),
  oneItem: L("1 item", "1 सामान", "1 वस्तू"),
  cod: L("COD — collect", "COD — लें", "COD — घ्या"),
  readySince: L("Ready {n} min ago", "{n} मिनट से तैयार", "{n} मिनिटांपासून तयार"),
  readyNow: L("Ready now", "अभी तैयार", "आता तयार"),
  left: L("{t} left", "{t} बाकी", "{t} बाकी"),
  accept: L("Accept", "स्वीकारें", "स्वीकारा"),
  reject: L("Reject", "मना करें", "नाकारा"),
  taken: L("Taken — another rider got it", "ले ली गई — दूसरे राइडर को मिल गई", "घेतली गेली — दुसऱ्या रायडरला मिळाली"),
  errAction: L("Could not update the delivery.", "डिलीवरी अपडेट नहीं हो सकी।", "डिलिव्हरी अपडेट करता आली नाही."),
  errNoServer: L(
    "Could not reach the server. Check your connection and try again.",
    "सर्वर से संपर्क नहीं हो सका। इंटरनेट देखें और फिर कोशिश करें।",
    "सर्व्हरशी संपर्क झाला नाही. इंटरनेट तपासा आणि पुन्हा प्रयत्न करा.",
  ),
} as const;

const DEFAULT_POLL_MS = 10_000;

function countdown(expiresAt: string | null, now: number): string | null {
  if (!expiresAt) return null;
  const left = Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export function AvailableDeliveries({ initialPollSeconds, lang = "en" }: { initialPollSeconds: number; lang?: Lang }) {
  const router = useRouter();
  const [board, setBoard] = useState<Pick<JobBoard, "enabled" | "blockedReason" | "jobs"> | null>(null);
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollMs = initialPollSeconds * 1000 || DEFAULT_POLL_MS;
    let stopped = false;

    async function poll() {
      if (cancelled) return;
      // Paused while the tab / app is in the background; resumes on visibilitychange.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/delivery-partner/jobs", { cache: "no-store" });
        if (res.ok) {
          const body: JobBoard = await res.json();
          if (cancelled) return;
          setBoard({ enabled: body.enabled, blockedReason: body.blockedReason, jobs: body.jobs });
          if (body.pollSeconds) pollMs = body.pollSeconds * 1000;
          if (!body.enabled) {
            stopped = true; // switched off: stop polling
            return;
          }
        }
      } catch {
        // offline for a moment: try again on the next tick
      }
      if (!cancelled) timer = setTimeout(poll, pollMs);
    }
    function onVisible() {
      if (document.visibilityState !== "visible" || stopped) return;
      if (timer) clearTimeout(timer);
      void poll();
    }
    void poll();
    document.addEventListener("visibilitychange", onVisible);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [initialPollSeconds, reload]);

  async function post(job: RiderJob, path: "accept" | "pass", extra: Record<string, string> = {}) {
    setBusy(job.jobId);
    setError(null);
    try {
      const res = await fetch(`/api/delivery-partner/jobs/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.jobId, ...extra }),
      });
      if (res.ok) {
        setBoard((b) => (b ? { ...b, jobs: b.jobs.filter((j) => j.jobId !== job.jobId) } : b));
        if (path === "accept") router.refresh();
        return;
      }
      const body = await res.json().catch(() => null);
      if (res.status === 409 && body?.error?.details?.reason === "OFFER_TAKEN") {
        setTaken((s) => new Set(s).add(job.jobId));
        setReload((n) => n + 1);
      } else {
        setError(errorText(body?.error?.message ?? tr(T.errAction, lang), lang, body?.error?.code));
      }
    } catch {
      setError(tr(T.errNoServer, lang));
    } finally {
      setBusy(null);
    }
  }

  if (!board || !board.enabled) return null;
  if (board.blockedReason && board.blockedReason !== "NO_LOCATION") return null;

  // A job someone else took stays on screen with "Taken" until the next refresh drops it.
  const jobs = board.jobs;
  return (
    <section className="space-y-3" data-testid="available-deliveries" aria-label={tr(T.title, lang)}>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">{tr(T.title, lang)}</h2>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {board.blockedReason === "NO_LOCATION" ? (
        <p className="rounded-lg bg-cream-100 p-3 text-sm text-ink-700">{tr(T.noLocation, lang)}</p>
      ) : jobs.length === 0 ? (
        <p className="rounded-lg bg-cream-100 p-3 text-sm text-ink-700">{tr(T.none, lang)}</p>
      ) : null}
      {jobs.map((job) => {
        const isTaken = taken.has(job.jobId);
        const left = countdown(job.expiresAt, now);
        const readyMin = job.readySince ? Math.max(0, Math.floor((now - new Date(job.readySince).getTime()) / 60_000)) : null;
        return (
          <Card key={job.jobId} className="space-y-2 p-4" data-testid="job-card">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink-900">{job.shopName}</p>
                {job.shopArea ? <p className="truncate text-sm text-ink-500">{job.shopArea}</p> : null}
              </div>
              {left ? <Badge tone="warning">{tr(T.left, lang).replace("{t}", left)}</Badge> : null}
            </div>
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-ink-700">
              {job.pickupKm != null ? <span>{tr(T.pickup, lang).replace("{km}", job.pickupKm.toFixed(1))}</span> : null}
              {job.deliveryKm != null ? <span>{tr(T.drop, lang).replace("{km}", job.deliveryKm.toFixed(1))}</span> : null}
              {job.totalKm != null ? <span className="font-medium">{tr(T.total, lang).replace("{km}", job.totalKm.toFixed(1))}</span> : null}
              {job.etaMinutes != null ? <span>{tr(T.eta, lang).replace("{n}", String(job.etaMinutes))}</span> : null}
            </p>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {job.surgeTags.map((tag) => (
                <span key={tag} className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
                  ⚡ {tag}
                </span>
              ))}
              {job.cod && job.cashToCollectPaise != null ? (
                <span className="rounded-full bg-kesari-100 px-2 py-0.5 font-medium text-kesari-800" data-testid="job-cod">
                  {tr(T.cod, lang)} <Money paise={job.cashToCollectPaise} />
                </span>
              ) : null}
              {job.itemsCount > 0 ? (
                <span className="rounded-full bg-cream-100 px-2 py-0.5 text-ink-700">
                  {job.itemsCount === 1 ? tr(T.oneItem, lang) : tr(T.items, lang).replace("{n}", String(job.itemsCount))}
                </span>
              ) : null}
              {readyMin != null ? (
                <span className="rounded-full bg-cream-100 px-2 py-0.5 text-ink-700">
                  {readyMin < 1 ? tr(T.readyNow, lang) : tr(T.readySince, lang).replace("{n}", String(readyMin))}
                </span>
              ) : null}
            </div>
            {job.earnPaise != null ? <YouEarn earnPaise={job.earnPaise} breakdown={job.breakdown} lang={lang} /> : null}
            {isTaken ? (
              <p className="rounded-lg bg-cream-100 p-2 text-sm font-medium text-ink-700" data-testid="job-taken">
                {tr(T.taken, lang)}
              </p>
            ) : rejecting === job.jobId ? (
              <RejectReasonPicker
                lang={lang}
                busy={busy === job.jobId}
                onCancel={() => setRejecting(null)}
                onPick={(reason: RiderRejectReason, note: string) => {
                  setRejecting(null);
                  void post(job, "pass", note ? { reason, note } : { reason });
                }}
              />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Button size="lg" disabled={busy !== null} onClick={() => post(job, "accept")} data-testid="job-accept">
                  {tr(T.accept, lang)}
                </Button>
                <Button size="lg" variant="secondary" disabled={busy !== null} onClick={() => setRejecting(job.jobId)}>
                  {tr(T.reject, lang)}
                </Button>
              </div>
            )}
          </Card>
        );
      })}
    </section>
  );
}
