/**
 * Admin-tunable business rules.
 *
 * Code carries a default for every rule (src/server/config/rules.ts); an
 * admin can override any of them without a deploy. Overrides live in
 * `platform_settings`, are validated against the rule's schema on write, and
 * are audited. Reads are cached for a short time per process, so a change
 * reaches every instance within CACHE_MS.
 */
import { eq } from "drizzle-orm";

import { validationFailed } from "@/lib/errors";
import { RULES, type RuleKey, type RuleValue } from "@/server/config/rules";
import { db } from "@/server/db";
import { platformSettings, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: unknown }>();
/** The one read of every rule in progress, shared by everyone who missed the cache. */
let inflight: Promise<void> | null = null;

/** Effective value: stored override merged over the code default. */
export async function getRule<K extends RuleKey>(key: K): Promise<RuleValue<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as RuleValue<K>;
  // GAP-019: a miss reads every rule in one query. A checkout reads about eight
  // rules, and one database round trip per rule added up on a cold checkout
  // with a far database. Callers that miss at once share the read.
  if (!inflight) inflight = readAllRules().finally(() => (inflight = null));
  await inflight;
  // A write landed while that read was running: read once more.
  if (!cache.has(key)) await readAllRules();
  return (cache.get(key)?.value ?? RULES[key].defaults) as RuleValue<K>;
}

/** Bumped by every write, so a read that started before it cannot cache the old value. */
let generation = 0;

async function readAllRules(): Promise<void> {
  const startedAt = generation;
  let stored = new Map<string, unknown>();
  try {
    const rows = await db.select().from(platformSettings);
    stored = new Map(rows.map((r) => [r.key, r.value]));
  } catch (error) {
    console.error("[settings] read failed, using defaults", error);
  }
  if (generation !== startedAt) return;
  const at = Date.now();
  for (const key of Object.keys(RULES) as RuleKey[]) {
    const def = RULES[key];
    let value: unknown = def.defaults;
    if (stored.has(key)) {
      const merged = def.schema.safeParse({ ...(def.defaults as object), ...(stored.get(key) as object) });
      // A stored value that no longer validates (schema tightened later)
      // falls back to the safe default rather than breaking the flow.
      if (merged.success) value = merged.data;
    }
    cache.set(key, { at, value });
  }
}

export async function listRules(): Promise<
  { key: RuleKey; description: string; defaults: unknown; value: unknown; overridden: boolean }[]
> {
  const rows = await db.select().from(platformSettings);
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const out = [];
  for (const key of Object.keys(RULES) as RuleKey[]) {
    out.push({
      key,
      description: RULES[key].description,
      defaults: RULES[key].defaults,
      value: await getRule(key),
      overridden: stored.has(key),
    });
  }
  return out;
}

/** Replaces the override for `key`. Partial input is completed from the defaults. */
export async function setRule<K extends RuleKey>(
  key: K,
  input: unknown,
  actor: { id: string; role: UserRole },
): Promise<RuleValue<K>> {
  const def = RULES[key];
  if (!def) throw validationFailed(`Unknown setting "${key}".`);
  const parsed = def.schema.safeParse({ ...(def.defaults as object), ...((input as object) ?? {}) });
  if (!parsed.success) {
    throw validationFailed("That value is not allowed for this setting.", {
      fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join(".") || "_", i.message])),
    });
  }
  const previous = await getRule(key);
  await db
    .insert(platformSettings)
    .values({ key, value: parsed.data, updatedBy: actor.id })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: parsed.data, updatedBy: actor.id, updatedAt: new Date() },
    });
  cache.delete(key);
  generation += 1;
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SETTING_CHANGED,
    entityType: "platform_setting",
    entityId: key,
    previousValue: previous,
    newValue: parsed.data,
  });
  return parsed.data as RuleValue<K>;
}

/** Removes the override, restoring the code default. */
export async function resetRule(key: RuleKey, actor: { id: string; role: UserRole }): Promise<void> {
  const previous = await getRule(key);
  await db.delete(platformSettings).where(eq(platformSettings.key, key));
  cache.delete(key);
  generation += 1;
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SETTING_CHANGED,
    entityType: "platform_setting",
    entityId: key,
    previousValue: previous,
    newValue: { reset: true },
  });
}

/** For tests: forget cached values. */
export function clearRuleCache(): void {
  cache.clear();
  inflight = null;
  generation += 1;
}
