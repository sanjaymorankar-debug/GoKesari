/**
 * F13.1.2: push is on by default only where it makes sense — for people who
 * have the app signed in (an active token) and for the categories in rule
 * push.defaultOnCategories — and only while rule push.enabled is on. A
 * person's own switch for the category always wins (notification_preferences).
 */
import type { DbClient } from "@/server/db";
import { db } from "@/server/db";
import type { CategoryKey } from "../templates";
import { getRule } from "@/server/services/settings";
import { pushConfigProblem } from "./provider";
import { hasActivePushToken } from "./tokens";

/** Whether PUSH is on by default for this person and category (before their own switch). */
export async function pushOnByDefault(userId: string, category: CategoryKey, client: DbClient = db): Promise<boolean> {
  const rules = await getRule("push");
  if (!rules.enabled || pushConfigProblem(rules)) return false;
  if (!(rules.defaultOnCategories as readonly string[]).includes(category)) return false;
  return hasActivePushToken(userId, client);
}

/** For the settings matrix: is the push channel offered at all, and which categories default on for this person. */
export async function pushPreferenceDefaults(userId: string): Promise<{ available: boolean; defaultOn: Set<string> }> {
  const rules = await getRule("push");
  const available = rules.enabled && !pushConfigProblem(rules);
  if (!available || !(await hasActivePushToken(userId))) return { available, defaultOn: new Set() };
  return { available, defaultOn: new Set(rules.defaultOnCategories) };
}
