"use client";

/** Confirmation page helpers: the video "Join" button that opens 10 minutes before the slot. */
import { useEffect, useState } from "react";

export function JoinVideoButton({ url, startsAt, endsAt }: { url: string; startsAt: string; endsAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, []);
  const opens = new Date(startsAt).getTime() - 10 * 60_000;
  const closes = new Date(endsAt).getTime() + 30 * 60_000;
  const open = now >= opens && now <= closes;
  if (open) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center justify-center rounded-lg bg-leaf-700 px-5 text-base font-bold text-white" data-testid="health-video-join">
        🎥 Join the video consultation
      </a>
    );
  }
  return (
    <p className="rounded-xl border-2 border-[var(--gk-line)] bg-white p-3 text-sm text-ink-700" data-testid="health-video-join-later">
      {now < opens ? "The Join button opens here 10 minutes before your time." : "This video consultation time is over."}
    </p>
  );
}
