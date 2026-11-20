"use client";

/**
 * GoKesari Health: live updates in the browser (and the app's WebView) from /api/health/stream.
 * useHealthLive(names, onEvent) calls onEvent for matching events (debounced); <LiveRefresh/> simply
 * refreshes the server component page. EventSource reconnects by itself after a network drop.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export interface LiveEvent {
  id: number;
  name: string;
  shopId: string | null;
  subjectId: string | null;
  payload: Record<string, unknown>;
  at: string;
}

type Status = "connecting" | "live" | "offline";

export function useHealthLive(match: (e: LiveEvent) => boolean, onEvent: (e: LiveEvent) => void, debounceMs = 300): Status {
  const [status, setStatus] = useState<Status>("connecting");
  const matchRef = useRef(match);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    matchRef.current = match;
    onEventRef.current = onEvent;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last: LiveEvent | null = null;
    const source = new EventSource("/api/health/stream");
    source.addEventListener("ready", () => setStatus("live"));
    source.addEventListener("health", (msg) => {
      try {
        const e = JSON.parse((msg as MessageEvent<string>).data) as LiveEvent;
        if (!matchRef.current(e)) return;
        last = e;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => last && onEventRef.current(last), debounceMs);
      } catch {
        /* ignore a malformed event */
      }
    });
    source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? "offline" : "connecting");
    source.onopen = () => setStatus("live");
    return () => {
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [debounceMs]);
  return status;
}

/** Plays a short tone (new booking / cancellation / check-in on the doctor's screen). */
export function chime(): void {
  try {
    const Ctx = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.5);
  } catch {
    /* sound is optional */
  }
}

/** Refreshes the current server-rendered page when a matching event arrives. */
export function LiveRefresh({ names, shopId, subjectId, sound = false }: { names?: string[]; shopId?: string; subjectId?: string; sound?: boolean }) {
  const router = useRouter();
  const status = useHealthLive(
    (e) => (!names || names.some((n) => e.name === n || (n.endsWith(".") && e.name.startsWith(n)))) && (!shopId || e.shopId === shopId || !e.shopId) && (!subjectId || e.subjectId === subjectId || !e.subjectId),
    () => {
      if (sound) chime();
      router.refresh();
    },
  );
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-ink-600" data-testid="health-live" data-status={status} aria-live="polite">
      <span className={status === "live" ? "h-2 w-2 rounded-full bg-leaf-600" : status === "connecting" ? "h-2 w-2 rounded-full bg-amber-500" : "h-2 w-2 rounded-full bg-stone-400"} />
      {status === "live" ? "Live" : status === "connecting" ? "Connecting…" : "Offline — pull to refresh"}
    </span>
  );
}
