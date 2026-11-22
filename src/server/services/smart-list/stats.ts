/**
 * Admin / operator dashboard figures for smart shopping (docs/smart-shopping-2026-11): list scans per day,
 * AI match accuracy (what the customer kept vs what AI suggested), AI calls, response time and cost per
 * feature. Days are IST dates.
 */
import { sql } from "drizzle-orm";

import { db } from "@/server/db";

export interface ScanDay {
  day: string;
  scans: number;
  read: number;
  unreadable: number;
  lines: number;
}

export interface AccuracySummary {
  /** Saved items that had an AI match. */
  aiMatched: number;
  /** …of which the customer kept the AI's product. */
  kept: number;
  /** Saved items the AI could not match (customer picked or left unmatched). */
  unmatched: number;
  accuracyPct: number | null;
}

export interface AiDay {
  day: string;
  feature: string;
  calls: number;
  ok: number;
  failed: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  costUsd: number;
}

const IST = sql.raw(`'Asia/Kolkata'`);

export async function smartShoppingStats(days = 30): Promise<{ scans: ScanDay[]; accuracy: AccuracySummary; ai: AiDay[] }> {
  const since = sql`now() - make_interval(days => ${days})`;
  const [scans, accuracy, ai] = await Promise.all([
    db.execute(sql`
      SELECT to_char(created_at AT TIME ZONE ${IST}, 'YYYY-MM-DD') AS day,
        count(*)::int AS scans,
        count(*) FILTER (WHERE status = 'READ')::int AS read,
        count(*) FILTER (WHERE status <> 'READ')::int AS unreadable,
        coalesce(sum(line_count), 0)::int AS lines
      FROM shopping_list_scans WHERE created_at >= ${since}
      GROUP BY 1 ORDER BY 1 DESC`),
    db.execute(sql`
      SELECT count(*) FILTER (WHERE i.ai_product_id IS NOT NULL)::int AS ai_matched,
        count(*) FILTER (WHERE i.ai_product_id IS NOT NULL AND i.product_id = i.ai_product_id)::int AS kept,
        count(*) FILTER (WHERE i.ai_product_id IS NULL)::int AS unmatched
      FROM smart_wishlist_items i JOIN smart_wishlists w ON w.id = i.wishlist_id
      WHERE w.scan_id IS NOT NULL AND i.created_at >= ${since}`),
    db.execute(sql`
      SELECT to_char(created_at AT TIME ZONE ${IST}, 'YYYY-MM-DD') AS day, feature,
        count(*)::int AS calls,
        count(*) FILTER (WHERE outcome = 'OK')::int AS ok,
        count(*) FILTER (WHERE outcome <> 'OK')::int AS failed,
        coalesce(avg(latency_ms), 0)::int AS avg_latency_ms,
        coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_latency_ms,
        coalesce(sum(cost_micros), 0)::bigint AS cost_micros
      FROM ai_usage_log WHERE created_at >= ${since}
      GROUP BY 1, 2 ORDER BY 1 DESC, 2`),
  ]);
  const a = (accuracy as unknown as { ai_matched: number; kept: number; unmatched: number }[])[0] ?? { ai_matched: 0, kept: 0, unmatched: 0 };
  return {
    scans: (scans as unknown as ScanDay[]).map((r) => ({ ...r })),
    accuracy: {
      aiMatched: a.ai_matched,
      kept: a.kept,
      unmatched: a.unmatched,
      accuracyPct: a.ai_matched > 0 ? Math.round((a.kept / a.ai_matched) * 1000) / 10 : null,
    },
    ai: (ai as unknown as { day: string; feature: string; calls: number; ok: number; failed: number; avg_latency_ms: number; p95_latency_ms: number; cost_micros: string | number }[]).map((r) => ({
      day: r.day,
      feature: r.feature,
      calls: r.calls,
      ok: r.ok,
      failed: r.failed,
      avgLatencyMs: r.avg_latency_ms,
      p95LatencyMs: r.p95_latency_ms,
      costUsd: Number(r.cost_micros) / 1_000_000,
    })),
  };
}
