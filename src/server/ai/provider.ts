/**
 * One door for every AI call that reads photos or free text
 * (docs/smart-shopping-2026-11): shopping-list photos, product photos, spoken
 * price/stock, WhatsApp replies. Features ask `runAi()` for a structured answer
 * against a zod schema; which provider and model answer is admin config
 * (rule smartShopping.aiProvider / aiModel), so the vision model can be swapped
 * without touching a feature.
 *
 * Every call is:
 *   - refused when the provider is "off" or has no key (AI_UNAVAILABLE),
 *   - limited per user per day (rule smartShopping.aiCallsPerUserPerDay), counted
 *     in the database so the limit holds across app instances,
 *   - logged in ai_usage_log with tokens, estimated cost and latency (never the
 *     photo or the text itself).
 */
import { and, count, eq, gte } from "drizzle-orm";
import type { z } from "zod";

import { AppError } from "@/lib/errors";
import { db } from "@/server/db";
import { aiUsageLog } from "@/server/db/schema";
import { getRule } from "@/server/services/settings";
import { claudeProvider } from "./providers/claude";

export type AiFeature = "LIST_SCAN" | "PRODUCT_PHOTO" | "VOICE_PARSE" | "WHATSAPP_INTENT" | "VOICE_COMMAND";

export interface AiImage {
  bytes: Buffer;
  /** image/jpeg, image/png, image/webp or application/pdf */
  contentType: string;
}

export interface AiRequest<T> {
  /** Photos or PDFs, in order (pages of one list, sides of one product). */
  images?: AiImage[];
  /** Plain text instead of, or as well as, images (typed list, speech transcript). */
  text?: string;
  /** What to do. Fixed per feature, so it caches well. */
  instructions: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiResult<T> {
  /** null when the model declined or returned nothing usable. */
  output: T | null;
  usage: AiUsage;
  model: string;
}

/** A provider reads images/text into a schema. Add one by implementing this and naming it in the rule. */
export interface AiProvider {
  readonly name: "claude";
  available(): boolean;
  defaultModel(): string;
  structured<T>(req: AiRequest<T>, model: string): Promise<AiResult<T>>;
  /** US dollars per million tokens for a model, for the cost log; null when unknown. */
  pricePerMTok(model: string): { input: number; output: number } | null;
}

const PROVIDERS: Record<AiProvider["name"], AiProvider> = { claude: claudeProvider };

export interface AiCaller {
  feature: AiFeature;
  /** Who the call is charged to for the daily limit (customer or shop owner). */
  userId: string;
  shopId?: string | null;
}

export class AiUnavailableError extends AppError {
  constructor(message = "Reading photos is not available right now. Please type your list instead.") {
    super("CONFLICT", message, { reason: "AI_UNAVAILABLE" });
  }
}

/** The configured provider, or null when AI is switched off or has no key. */
export async function activeAiProvider(): Promise<{ provider: AiProvider; model: string } | null> {
  const rule = await getRule("smartShopping");
  if (rule.aiProvider === "off") return null;
  const provider = PROVIDERS[rule.aiProvider];
  if (!provider?.available()) return null;
  return { provider, model: rule.aiModel.trim() || provider.defaultModel() };
}

/** Midnight IST today, as a UTC instant — the daily limit resets at Indian midnight. */
export function startOfIstDay(now = new Date()): Date {
  const IST_MS = 330 * 60_000;
  const ist = new Date(now.getTime() + IST_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_MS);
}

async function enforceDailyLimit(userId: string, limit: number): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(aiUsageLog)
    .where(and(eq(aiUsageLog.userId, userId), gte(aiUsageLog.createdAt, startOfIstDay())));
  if ((row?.n ?? 0) >= limit) {
    throw new AppError("RATE_LIMITED", `You can use photo and voice reading ${limit} times a day. Please try again tomorrow, or type it in.`, {
      reason: "AI_DAILY_LIMIT",
      limit,
    });
  }
}

/** Estimated cost in micro-dollars (1e-6 USD), integer so it sums exactly. */
export function costMicros(usage: AiUsage, price: { input: number; output: number } | null): number | null {
  if (!price) return null;
  return Math.round(usage.inputTokens * price.input + usage.outputTokens * price.output);
}

/**
 * Runs one AI read for a feature. Throws AiUnavailableError when AI is off,
 * RATE_LIMITED past the daily limit; returns null output when the model
 * declined. Provider errors are logged and rethrown as AiUnavailableError.
 */
export async function runAi<T>(caller: AiCaller, req: AiRequest<T>): Promise<AiResult<T>> {
  const active = await activeAiProvider();
  if (!active) throw new AiUnavailableError();
  const rule = await getRule("smartShopping");
  await enforceDailyLimit(caller.userId, rule.aiCallsPerUserPerDay);

  const started = Date.now();
  let result: AiResult<T> | null = null;
  let error: string | null = null;
  try {
    result = await active.provider.structured(req, active.model);
    return result;
  } catch (e) {
    error = e instanceof Error ? e.name + ": " + e.message.slice(0, 200) : "unknown";
    throw new AiUnavailableError("Reading failed just now. Please try again in a minute, or type it in.");
  } finally {
    const usage = result?.usage ?? { inputTokens: 0, outputTokens: 0 };
    await db
      .insert(aiUsageLog)
      .values({
        feature: caller.feature,
        userId: caller.userId,
        shopId: caller.shopId ?? null,
        provider: active.provider.name,
        model: result?.model ?? active.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicros: costMicros(usage, active.provider.pricePerMTok(result?.model ?? active.model)),
        latencyMs: Date.now() - started,
        imageCount: req.images?.length ?? 0,
        outcome: error ? "ERROR" : result?.output ? "OK" : "DECLINED",
        error,
      })
      .catch((e) => console.error("[ai] usage log failed", e));
  }
}
