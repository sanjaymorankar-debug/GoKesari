"use client";

/**
 * Admin → Shops → Send welcome kit (docs/shop-welcome-kit-2026-11, requirement 7):
 * shops that were live before the welcome kit existed get it only when an admin
 * sends it — one shop, or every live shop of a city or district that never had
 * it (preview first, then send). Once per shop, ever; same outbox as the
 * automatic e-mail. Off until the feature flag is on.
 */
import { useState } from "react";

import { Icon } from "@/components/board/icons";

export interface WelcomeKitShopRow {
  id: string;
  name: string;
  registrationNumber: string | null;
  city: string;
  pincode: string;
  ownerHasEmail: boolean;
  local: "mr" | "hi";
  welcomeKit: { status: string; sentAt: string | null; createdAt: string; lastError: string | null } | null;
}

const LANGUAGE = { mr: "Marathi", hi: "Hindi" } as const;

function istTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).replace(/ /g, "-");
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).replace(":", ".");
  return `${date}, ${time} IST`;
}

function statusText(kit: WelcomeKitShopRow["welcomeKit"]): string {
  if (!kit) return "Not sent";
  if (kit.status === "SENT" && kit.sentAt) return `Sent ${istTime(kit.sentAt)}`;
  if (kit.status === "PENDING" || kit.status === "SENDING") return `Queued ${istTime(kit.createdAt)}`;
  if (kit.status === "SKIPPED") return `Skipped — ${kit.lastError ?? "no e-mail address"}`;
  if (kit.status === "FAILED") return `Retrying — ${kit.lastError ?? "send failed"}`;
  return kit.status;
}

async function call<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error?.message ?? "Something went wrong.");
  return payload as T;
}

export function AdminWelcomeKit({ enabled, districts }: { enabled: boolean; districts: { code: string; name: string }[] }) {
  const [q, setQ] = useState("");
  const [notWelcomed, setNotWelcomed] = useState(true);
  const [rows, setRows] = useState<WelcomeKitShopRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [preview, setPreview] = useState<{ total: number; key: string } | null>(null);
  const [told, setTold] = useState(false);

  const say = (tone: "ok" | "error", text: string) => setMessage({ tone, text });

  async function search(event?: React.FormEvent) {
    event?.preventDefault();
    setBusy("search");
    setMessage(null);
    try {
      const params = new URLSearchParams({ q: q.trim() });
      if (notWelcomed) params.set("notWelcomed", "1");
      const data = await call<{ total: number; shops: WelcomeKitShopRow[] }>(`/api/admin/shops/welcome-kit?${params}`);
      setRows(data.shops);
      setTotal(data.total);
    } catch (error) {
      say("error", error instanceof Error ? error.message : "Could not search.");
    } finally {
      setBusy(null);
    }
  }

  async function sendOne(row: WelcomeKitShopRow) {
    setBusy(row.id);
    setMessage(null);
    try {
      const data = await call<{ result: string; welcomeKit: WelcomeKitShopRow["welcomeKit"] }>("/api/admin/shops/welcome-kit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shopId: row.id }),
      });
      setRows((current) => current?.map((r) => (r.id === row.id ? { ...r, welcomeKit: data.welcomeKit } : r)) ?? null);
      if (data.result === "QUEUED") say("ok", `Welcome kit queued for ${row.name}. It goes out within a minute.`);
      else if (data.result === "ALREADY_SENT") say("error", `${row.name} already had the welcome kit — each shop gets it once.`);
      else say("error", `Not queued: the owner of ${row.name} has turned off shop e-mails.`);
    } catch (error) {
      say("error", error instanceof Error ? error.message : "Could not send.");
    } finally {
      setBusy(null);
    }
  }

  const bulkKey = `${city.trim().toLowerCase()}|${district}`;

  async function previewBulk() {
    if (!city.trim() && !district) return say("error", "Choose a city or a district.");
    setBusy("preview");
    setMessage(null);
    try {
      const params = new URLSearchParams({ notWelcomed: "1" });
      if (city.trim()) params.set("city", city.trim());
      if (district) params.set("district", district);
      const data = await call<{ total: number; shops: WelcomeKitShopRow[] }>(`/api/admin/shops/welcome-kit?${params}`);
      setPreview({ total: data.total, key: bulkKey });
      setRows(data.shops);
      setTotal(data.total);
    } catch (error) {
      say("error", error instanceof Error ? error.message : "Could not preview.");
    } finally {
      setBusy(null);
    }
  }

  async function sendBulk() {
    if (!preview || preview.key !== bulkKey || preview.total === 0) return;
    const count = Math.min(preview.total, 200);
    if (!window.confirm(`Send the welcome kit to ${count} live shop${count === 1 ? "" : "s"}? Each shop gets it once, ever.`)) return;
    setBusy("bulk");
    setMessage(null);
    try {
      const data = await call<{ matched: number; queued: number; notQueued: number; remaining: number }>("/api/admin/shops/welcome-kit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bulk: { ...(city.trim() ? { city: city.trim() } : {}), ...(district ? { districtCode: district } : {}) } }),
      });
      say(
        "ok",
        `Queued ${data.queued} welcome kit${data.queued === 1 ? "" : "s"}${data.notQueued ? ` (${data.notQueued} not queued: shop e-mails turned off)` : ""}. They go out over the next minutes.${data.remaining ? ` ${data.remaining} more remain — run it again.` : ""}`,
      );
      setPreview(null);
      setTold(false);
    } catch (error) {
      say("error", error instanceof Error ? error.message : "Could not send.");
    } finally {
      setBusy(null);
    }
  }

  const box = "rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4";
  const input = "min-h-11 rounded-xl border-2 border-[var(--gk-line)] bg-white px-3 text-sm text-ink-900";
  const primary = "inline-flex min-h-11 items-center gap-2 rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800 disabled:opacity-60";
  const secondary = "inline-flex min-h-11 items-center gap-2 rounded-xl border-2 border-[var(--gk-line)] bg-white px-4 text-sm font-bold text-ink-900 hover:border-kesari-600 disabled:opacity-60";

  return (
    <div className="flex flex-col gap-4" data-testid="admin-welcome-kit">
      {!enabled ? (
        <p className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm text-ink-800" data-testid="welcome-kit-off">
          Sending is off. Turn on <strong>Send welcome kit to existing shops</strong> in{" "}
          <a href="/admin/feature-flags" className="font-semibold text-kesari-800 underline">
            Admin → Feature flags
          </a>{" "}
          to use the buttons below. New shops get the welcome kit automatically either way.
        </p>
      ) : null}
      {message ? (
        <p role="status" className={`text-sm font-semibold ${message.tone === "ok" ? "text-green-800" : "text-red-700"}`} data-testid="welcome-kit-message">
          {message.text}
        </p>
      ) : null}

      <section className={box} aria-labelledby="wk-one">
        <h2 id="wk-one" className="text-base font-bold text-ink-900">One shop</h2>
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={search}>
          <label className="sr-only" htmlFor="wk-q">Shop name or registration number</label>
          <input id="wk-q" className={`${input} min-w-0 flex-1`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Shop name or registration number" />
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink-800">
            <input type="checkbox" checked={notWelcomed} onChange={(e) => setNotWelcomed(e.target.checked)} /> Only shops without it
          </label>
          <button type="submit" className={secondary} disabled={busy !== null}>
            <Icon name="search" size={16} /> {busy === "search" ? "Searching…" : "Search"}
          </button>
        </form>
      </section>

      <section className={box} aria-labelledby="wk-bulk">
        <h2 id="wk-bulk" className="text-base font-bold text-ink-900">Bulk run by city or district</h2>
        <p className="mt-1 text-sm text-ink-700">
          Every live shop there that never had the welcome kit, up to 200 per run. The e-mails go out over the next minutes. On gokesari.com, tell the owner before you run it.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="wk-city">City</label>
          <input id="wk-city" className={input} value={city} onChange={(e) => setCity(e.target.value)} placeholder="City, e.g. Pune" />
          <label className="sr-only" htmlFor="wk-district">District</label>
          <select id="wk-district" className={input} value={district} onChange={(e) => setDistrict(e.target.value)}>
            <option value="">Any district</option>
            {districts.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name}
              </option>
            ))}
          </select>
          <button type="button" className={secondary} disabled={busy !== null} onClick={previewBulk}>
            {busy === "preview" ? "Checking…" : "Preview"}
          </button>
        </div>
        {preview && preview.key === bulkKey ? (
          <div className="mt-3 flex flex-col gap-2" data-testid="welcome-kit-preview">
            <p className="text-sm font-semibold text-ink-900">
              {preview.total === 0 ? "Every live shop there already had the welcome kit." : `${preview.total} live shop${preview.total === 1 ? "" : "s"} never had the welcome kit (listed below).`}
            </p>
            {preview.total > 0 ? (
              <>
                <label className="flex items-center gap-2 text-sm text-ink-800">
                  <input type="checkbox" checked={told} onChange={(e) => setTold(e.target.checked)} /> The owner knows about this bulk run
                </label>
                <button type="button" className={`${primary} self-start`} disabled={!enabled || !told || busy !== null} onClick={sendBulk}>
                  <Icon name="megaphone" size={16} /> {busy === "bulk" ? "Queuing…" : `Send to ${Math.min(preview.total, 200)} shop${preview.total === 1 ? "" : "s"}`}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      {rows ? (
        <section aria-label="Shops">
          <p className="mb-2 text-sm text-ink-700">
            {total === 0 ? "No live shop matches." : `${total} live shop${total === 1 ? "" : "s"}${total > rows.length ? ` (first ${rows.length} shown)` : ""}.`}
          </p>
          <ul className="grid gap-2 lg:grid-cols-2">
            {rows.map((row) => (
              <li key={row.id} className={box} data-testid="welcome-kit-shop">
                <p className="truncate text-base font-bold text-ink-900">{row.name}</p>
                <p className="text-xs text-ink-600">
                  {[row.registrationNumber, `${row.city} ${row.pincode}`, `English + ${LANGUAGE[row.local]}`].filter(Boolean).join(" · ")}
                </p>
                <p className="mt-1 text-sm text-ink-800" data-testid="welcome-kit-status">
                  {statusText(row.welcomeKit)}
                  {!row.ownerHasEmail ? " · The owner has no e-mail address: the outbox will skip it." : ""}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className={primary} disabled={!enabled || Boolean(row.welcomeKit) || busy !== null} onClick={() => sendOne(row)}>
                    <Icon name="megaphone" size={16} /> {busy === row.id ? "Sending…" : "Send welcome kit"}
                  </button>
                  <a className={secondary} href={`/api/shops/${row.id}/banner?lang=en`}>
                    English PDF
                  </a>
                  <a className={secondary} href={`/api/shops/${row.id}/banner?lang=local`}>
                    {LANGUAGE[row.local]} PDF
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
