"use client";

/**
 * Doctor page actions: call (the clinic's GoKesari virtual number on Prime — calls are tracked — else its
 * own number), WhatsApp, and share the profile (Web Share where the phone has it, else a WhatsApp link /
 * copy link).
 */
import { useState } from "react";

const telOf = (n: string) => `tel:${n.replace(/[^\d+]/g, "")}`;
const waOf = (n: string, text: string) => {
  const digits = n.replace(/\D/g, "");
  const full = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
};

export function CallButtons({ phone, whatsapp, tracked, doctor }: { phone: string | null; whatsapp: string | null; tracked: boolean; doctor: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {phone ? (
        <a href={telOf(phone)} className="inline-flex min-h-11 items-center gap-1 rounded-lg border-2 border-leaf-300 bg-leaf-50 px-4 text-sm font-bold text-leaf-700" data-testid="health-doctor-call" title={tracked ? "GoKesari number: forwarded to the clinic" : undefined}>
          📞 Call {phone}
        </a>
      ) : null}
      {whatsapp ? (
        <a href={waOf(whatsapp, `Hello, I found ${doctor} on GoKesari Health and would like to ask about an appointment.`)} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 rounded-lg border-2 border-[var(--gk-line)] bg-white px-4 text-sm font-bold text-ink-800" data-testid="health-doctor-whatsapp">
          💬 WhatsApp
        </a>
      ) : null}
    </div>
  );
}

export function ShareProfile({ title, path }: { title: string; path: string }) {
  const [copied, setCopied] = useState(false);
  const url = () => (typeof window === "undefined" ? path : new URL(path, window.location.origin).toString());
  const share = async () => {
    const data = { title, text: `${title} on GoKesari Health`, url: url() };
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await navigator.share(data);
        return;
      } catch {
        /* cancelled: fall through to copy */
      }
    }
    try {
      await navigator.clipboard.writeText(data.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* nothing more to do */
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={share} className="inline-flex min-h-11 items-center gap-1 rounded-lg border-2 border-[var(--gk-line)] bg-white px-4 text-sm font-bold text-ink-800" data-testid="health-doctor-share">
        🔗 {copied ? "Link copied" : "Share profile"}
      </button>
      <a
        href={`https://wa.me/?text=${encodeURIComponent(`${title} on GoKesari Health: ${typeof window === "undefined" ? path : url()}`)}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-11 items-center gap-1 rounded-lg border-2 border-[var(--gk-line)] bg-white px-4 text-sm font-bold text-ink-800"
      >
        Share on WhatsApp
      </a>
    </div>
  );
}
