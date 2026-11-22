/**
 * Photo shopping list — OCR / match accuracy and response time (docs/smart-shopping-2026-11, testing §3).
 * Sends every image in tests/fixtures/smart-list-ocr (synthetic set + the owner's real photos, listed in
 * expected.json) to POST /api/smart-list/scans as the QA customer and compares the result with the
 * expected items:
 *   item recall      expected items found among the read lines (English name match)
 *   quantity correct found items whose normalised amount + unit equal the expected
 *   catalogue match  found items matched to a catalogue product
 *   unreadable       images that should be refused are refused (and readable ones are not)
 *   response time    wall-clock of each upload, ms
 * Each image is one paid AI call. Never against production (the QA session helper refuses it).
 *
 *   E2E_BASE_URL=https://test.gokesari.com npx tsx scripts/qa/smart-list-ocr-benchmark.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { request as playwrightRequest } from "@playwright/test";

import { storageFor } from "../../tests/qa/lib/actors";
import { BASE_URL, TARGET } from "../../tests/qa/lib/target";

type Item = { nameEn: string; amount: number; unit: string };
type Expected = { file: string; synthetic: boolean; lang: string; kind: string; items: Item[]; expectUnreadable: boolean };
type Line = { nameEn: string; quantityAmount: number; quantityUnit: string; productId: string | null; matchConfidence: number };

const DIR = path.resolve("tests/fixtures/smart-list-ocr");

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const ALIASES: Record<string, string[]> = {
  "cooking oil": ["oil", "sunflower oil", "groundnut oil"],
  "wheat flour": ["atta", "flour"],
  biscuits: ["biscuit", "parle g", "parle"],
  noodles: ["maggi", "instant noodles"],
  detergent: ["surf excel", "washing powder"],
  "toor dal": ["tur dal", "toor dal", "pigeon pea", "arhar dal", "dal"],
  tea: ["tea", "tea leaves", "tea powder"],
  cumin: ["jeera", "cumin seeds"],
};
function sameItem(expected: string, got: string): boolean {
  const e = norm(expected);
  const g = norm(got);
  if (!g) return false;
  if (g.includes(e) || e.includes(g)) return true;
  return (ALIASES[e] ?? []).some((a) => g.includes(a));
}

async function main() {
  const expected = JSON.parse(readFileSync(path.join(DIR, "expected.json"), "utf8")) as Expected[];
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: await storageFor("customer"), timeout: 180_000 });
  const started = new Date();
  type Row = {
    file: string; synthetic: boolean; lang: string; kind: string; http: number; ms: number; status: string; unreadableReason: string | null;
    unreadableOk: boolean; expectedItems: number; found: number; qtyOk: number; matched: number; extraLines: number;
    detail: { item: string; found: boolean; qtyOk: boolean; matched: boolean; got: string | null }[];
  };
  const rows: Row[] = [];
  for (const exp of expected) {
    const bytes = readFileSync(path.join(DIR, exp.file));
    const t0 = Date.now();
    const res = await api.post("/api/smart-list/scans", {
      multipart: { page: { name: exp.file, mimeType: exp.file.endsWith(".png") ? "image/png" : "image/jpeg", buffer: bytes }, lang: "en" },
    });
    const ms = Date.now() - t0;
    const body = (await res.json().catch(() => null)) as { status?: string; unreadableReason?: string; lines?: Line[]; error?: { message: string } } | null;
    const lines = body?.lines ?? [];
    const found = exp.items.map((it) => {
      const line = lines.find((l) => sameItem(it.nameEn, l.nameEn));
      return {
        item: it.nameEn,
        found: Boolean(line),
        qtyOk: Boolean(line && Math.abs(line.quantityAmount - it.amount) < 0.01 && line.quantityUnit === it.unit),
        matched: Boolean(line?.productId),
        got: line ? `${line.nameEn} ${line.quantityAmount} ${line.quantityUnit}` : null,
      };
    });
    const unreadable = body?.status === "UNREADABLE";
    rows.push({
      file: exp.file,
      synthetic: exp.synthetic,
      lang: exp.lang,
      kind: exp.kind,
      http: res.status(),
      ms,
      status: body?.status ?? body?.error?.message ?? "?",
      unreadableReason: body?.unreadableReason ?? null,
      unreadableOk: exp.expectUnreadable ? unreadable : !unreadable,
      expectedItems: exp.items.length,
      found: found.filter((f) => f.found).length,
      qtyOk: found.filter((f) => f.qtyOk).length,
      matched: found.filter((f) => f.matched).length,
      extraLines: Math.max(0, lines.length - found.filter((f) => f.found).length),
      detail: found,
    });
    console.log(`${exp.file}: ${res.status()} ${ms} ms · found ${rows.at(-1)!.found}/${exp.items.length} · qty ${rows.at(-1)!.qtyOk} · ${body?.status}`);
  }
  const sum = (k: "expectedItems" | "found" | "qtyOk" | "matched") => rows.reduce((s, r) => s + r[k], 0);
  const times = rows.map((r) => r.ms).sort((a, b) => a - b);
  const summary = {
    target: TARGET,
    baseUrl: BASE_URL,
    startedIst: started.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    images: rows.length,
    syntheticImages: rows.filter((r) => r.synthetic).length,
    realImages: rows.filter((r) => !r.synthetic).length,
    itemRecallPct: Math.round((sum("found") / Math.max(1, sum("expectedItems"))) * 1000) / 10,
    quantityAccuracyPct: Math.round((sum("qtyOk") / Math.max(1, sum("found"))) * 1000) / 10,
    catalogueMatchPct: Math.round((sum("matched") / Math.max(1, sum("found"))) * 1000) / 10,
    unreadableHandledPct: Math.round((rows.filter((r) => r.unreadableOk).length / rows.length) * 1000) / 10,
    responseMs: { median: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)] ?? times.at(-1), max: times.at(-1) },
  };
  const out = path.resolve("docs/testing/qa-runs");
  mkdirSync(out, { recursive: true });
  const file = path.join(out, `${new Date().toISOString().slice(0, 10)}-${TARGET}-smart-list-ocr.json`);
  writeFileSync(file, JSON.stringify({ summary, rows }, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Written ${file}`);
  await api.dispose();
}

void main();
