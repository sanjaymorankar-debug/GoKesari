"use client";

/**
 * Billing v2 (docs/billing §4.7; scenario 16): the counter POS. It works from
 * the device's own copy of the item list and keeps bills in a queue on the
 * device (localStorage) while offline; every 15 seconds and whenever the
 * network comes back it sends the queue. GoKesari numbers each bill in the
 * shop's series as it arrives (no gaps) and recognises a bill sent twice by
 * its own id (no duplicates); the screen then shows the invoice number, the
 * 80 mm receipt with the UPI QR, and anything that changed (price, stock).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";

interface Item {
  id: string;
  name: string;
  unit: string;
  barcode: string | null;
  gstRateBp: number;
  pricePaise: number | null;
  stock: number;
}
interface Line {
  item: Item;
  qty: number;
}
interface QueuedBill {
  clientRef: string;
  createdAt: string;
  paymentMode: "CASH" | "UPI" | "CARD" | "CREDIT";
  buyerName: string | null;
  lines: { shopProductId: string; name: string; qtyMilli: number; pricePaise: number; gstRateBp: number }[];
  totalPaise: number;
}
interface SyncResult {
  clientRef: string;
  status: "CREATED" | "DUPLICATE" | "REJECTED";
  invoiceId?: string;
  invoiceNo?: string;
  reason?: string;
  warnings: string[];
}

const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;

/*
 * The device's copy: localStorage, read through useSyncExternalStore so every
 * write (and a write from another tab) shows at once. When storage is full or
 * blocked, a key falls back to memory for this session.
 */
const CHANGED = "gk-pos-changed";
const memory = new Map<string, string>();
const memoryOnly = new Set<string>();
const NO_ITEMS: { items: Item[] } = { items: [] };
const NONE: never[] = [];

function subscribeStore(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}
function readRaw(key: string): string | null {
  if (memoryOnly.has(key)) return memory.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}
function load<T>(key: string, fallback: T): T {
  const raw = readRaw(key);
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  try {
    localStorage.setItem(key, raw);
    memoryOnly.delete(key);
  } catch {
    memoryOnly.add(key);
  }
  window.dispatchEvent(new Event(CHANGED));
}
function useStored<T>(key: string, fallback: T): T {
  const raw = useSyncExternalStore(subscribeStore, () => readRaw(key), () => null);
  return useMemo(() => {
    try {
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }, [raw, fallback]);
}
function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export function PosScreen({ shopId, shopName }: { shopId: string; shopName: string }) {
  const api = `/api/shops/${shopId}/accounts`;
  const keys = useMemo(() => ({ items: `gk-pos:${shopId}:items`, queue: `gk-pos:${shopId}:queue`, done: `gk-pos:${shopId}:done` }), [shopId]);
  const items = useStored(keys.items, NO_ITEMS).items;
  const queue = useStored<QueuedBill[]>(keys.queue, NONE);
  const done = useStored<SyncResult[]>(keys.done, NONE);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<Line[]>([]);
  const [mode, setMode] = useState<QueuedBill["paymentMode"]>("CASH");
  const [buyer, setBuyer] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const syncing = useRef(false);

  useEffect(() => {
    fetch(`${api}/pos/items`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((body) => save(keys.items, { items: (body.data ?? body) as Item[], savedAt: new Date().toISOString() }))
      .catch(() => setMessage("Working offline with the saved item list."));
  }, [api, keys]);

  const sync = useCallback(async () => {
    if (syncing.current || !navigator.onLine) return;
    const pending: QueuedBill[] = load(keys.queue, []);
    if (!pending.length) return;
    syncing.current = true;
    try {
      const res = await fetch(`${api}/pos/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bills: pending.map(({ totalPaise: _t, ...b }) => (void _t, b)) }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const results = (body.data ?? body) as SyncResult[];
      const finished = new Set(results.map((r) => r.clientRef));
      // Bills made while this request ran stay in the queue.
      save(keys.queue, load<QueuedBill[]>(keys.queue, []).filter((b) => !finished.has(b.clientRef)));
      save(keys.done, [...results, ...load<SyncResult[]>(keys.done, [])].slice(0, 50));
    } catch {
      // Still offline or the server is busy: the queue stays and is sent next time.
    } finally {
      syncing.current = false;
    }
  }, [api, keys]);

  useEffect(() => {
    const up = () => void sync();
    window.addEventListener("online", up);
    const timer = window.setInterval(up, 15_000);
    up();
    return () => {
      window.removeEventListener("online", up);
      window.clearInterval(timer);
    };
  }, [sync]);

  const add = (item: Item) => setCart((c) => (c.some((l) => l.item.id === item.id) ? c.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + 1 } : l)) : [...c, { item, qty: 1 }]));
  const matches = query.trim() ? items.filter((i) => i.name.toLowerCase().includes(query.trim().toLowerCase()) || i.barcode === query.trim()).slice(0, 12) : [];
  const total = cart.reduce((n, l) => n + (l.item.pricePaise ?? 0) * l.qty, 0);

  async function scan() {
    const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (!Detector) return setMessage("This device cannot scan with the camera here: type the barcode or use a scanner.");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const video = document.createElement("video");
    video.srcObject = stream;
    await video.play();
    const detector = new Detector({ formats: ["ean_13", "ean_8", "upc_a", "code_128"] });
    try {
      for (let i = 0; i < 40; i += 1) {
        const [code] = await detector.detect(video);
        if (code) {
          const hit = items.find((x) => x.barcode === code.rawValue);
          if (hit) add(hit);
          else setMessage(`No item with barcode ${code.rawValue}.`);
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      setMessage("No barcode seen. Try again closer.");
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  function bill() {
    if (!cart.length) return;
    const b: QueuedBill = {
      clientRef: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      paymentMode: mode,
      buyerName: buyer.trim() || null,
      lines: cart.map((l) => ({ shopProductId: l.item.id, name: l.item.name, qtyMilli: l.qty * 1000, pricePaise: l.item.pricePaise ?? 0, gstRateBp: l.item.gstRateBp })),
      totalPaise: total,
    };
    save(keys.queue, [...load<QueuedBill[]>(keys.queue, []), b]);
    setCart([]);
    setBuyer("");
    setMessage(`Bill of ${rupees(b.totalPaise)} saved${navigator.onLine ? "" : " on this device — it will be sent when the internet is back"}.`);
    void sync();
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_22rem]" data-testid="pos">
      <div className="grid content-start gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold text-ink-900">Counter POS · {shopName}</h1>
          <Badge tone={online ? "success" : "warning"}>{online ? "online" : "offline"}</Badge>
          {queue.length ? <Badge tone="warning">{queue.length} bill(s) waiting to send</Badge> : null}
        </div>
        {message ? <Alert tone="info">{message}</Alert> : null}
        <div className="flex gap-2">
          <input
            aria-label="Search item or barcode"
            autoFocus
            className={inputClass}
            placeholder="Item name or barcode"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const exact = items.find((i) => i.barcode === query.trim()) ?? (matches.length === 1 ? matches[0] : null);
              if (exact) {
                add(exact);
                setQuery("");
              }
            }}
          />
          <Button variant="secondary" onClick={() => void scan()}>
            Scan
          </Button>
        </div>
        <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {matches.map((i) => (
            <li key={i.id}>
              <button type="button" className="w-full rounded-xl border border-[var(--gk-line)] bg-white p-2 text-left hover:bg-kesari-50" onClick={() => (add(i), setQuery(""))}>
                <span className="block text-sm font-semibold">{i.name}</span>
                <span className="text-xs text-ink-600">{i.pricePaise != null ? rupees(i.pricePaise) : "no price"} · stock {i.stock}</span>
              </button>
            </li>
          ))}
        </ul>
        {done.length ? (
          <Card className="p-3">
            <p className="mb-1 font-bold">Sent bills</p>
            <ul className="grid gap-1 text-sm" data-testid="pos-done">
              {done.slice(0, 10).map((r) => (
                <li key={r.clientRef} className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.status === "REJECTED" ? "danger" : "success"}>{r.status.toLowerCase()}</Badge>
                  {r.invoiceNo ? <span>{r.invoiceNo}</span> : null}
                  {r.invoiceId ? (
                    <a className="underline" href={`${api}/sales/${r.invoiceId}/receipt`}>
                      80 mm receipt
                    </a>
                  ) : null}
                  {r.reason ? <span className="text-red-700">{r.reason}</span> : null}
                  {r.warnings.map((w) => (
                    <span key={w} className="text-xs text-kesari-800">
                      {w}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
      <Card className="grid content-start gap-2 p-3">
        <p className="font-bold">Bill</p>
        <ul className="grid gap-1">
          {cart.map((l) => (
            <li key={l.item.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{l.item.name}</span>
              <button type="button" aria-label={`Less ${l.item.name}`} className="h-9 w-9 rounded-lg border" onClick={() => setCart((c) => c.flatMap((x) => (x.item.id !== l.item.id ? [x] : x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : [])))}>
                −
              </button>
              <span className="w-6 text-center tabular-nums">{l.qty}</span>
              <button type="button" aria-label={`More ${l.item.name}`} className="h-9 w-9 rounded-lg border" onClick={() => add(l.item)}>
                +
              </button>
              <span className="w-20 text-right tabular-nums">{rupees((l.item.pricePaise ?? 0) * l.qty)}</span>
            </li>
          ))}
        </ul>
        <p className="flex justify-between border-t pt-2 font-bold">
          <span>Total (incl. GST)</span>
          <span className="tabular-nums">{rupees(total)}</span>
        </p>
        <select aria-label="Payment" className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as QueuedBill["paymentMode"])}>
          <option value="CASH">Cash</option>
          <option value="UPI">UPI</option>
          <option value="CARD">Card</option>
          <option value="CREDIT">On account</option>
        </select>
        <input aria-label="Customer (optional)" className={inputClass} placeholder="Customer (optional)" value={buyer} onChange={(e) => setBuyer(e.target.value)} />
        <Button disabled={!cart.length || cart.some((l) => l.item.pricePaise == null)} onClick={bill}>
          Make bill
        </Button>
        <Button variant="secondary" disabled={!queue.length || !online} onClick={() => void sync()}>
          Send waiting bills now
        </Button>
      </Card>
    </div>
  );
}
