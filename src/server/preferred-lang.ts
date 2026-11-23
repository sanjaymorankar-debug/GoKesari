import { eq, inArray } from "drizzle-orm";

import { LANGUAGES, type Lang } from "@/lib/board/i18n";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";

/**
 * users.preferred_lang (migration 0189): the language a signed-in person last
 * picked on the EN / हिं / मरा switch. Read for the board-language fallback
 * and for notification wording. Never throws — a missing column (migration
 * not yet applied) or a database error reads as "not chosen".
 */

/** A stored value as a language, or null when blank or unknown. */
export function asSavedLang(value: unknown): Lang | null {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value) ? (value as Lang) : null;
}

export async function getPreferredLang(userId: string): Promise<Lang | null> {
  try {
    const [row] = await db
      .select({ lang: users.preferredLang })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return asSavedLang(row?.lang);
  } catch {
    return null;
  }
}

/** Languages for several people at once (notification fan-out); missing → not in the map. */
export async function getPreferredLangs(userIds: readonly string[]): Promise<Map<string, Lang>> {
  const out = new Map<string, Lang>();
  if (userIds.length === 0) return out;
  try {
    const rows = await db
      .select({ id: users.id, lang: users.preferredLang })
      .from(users)
      .where(inArray(users.id, [...new Set(userIds)]));
    for (const r of rows) {
      const lang = asSavedLang(r.lang);
      if (lang) out.set(r.id, lang);
    }
  } catch {
    // English for everyone.
  }
  return out;
}

/** Saves the choice for a signed-in person. Best effort: the cookie is already set. */
export async function savePreferredLang(userId: string, lang: Lang): Promise<void> {
  try {
    await db.update(users).set({ preferredLang: lang }).where(eq(users.id, userId));
  } catch {
    // Column not migrated yet, or a transient error — the cookie still holds the choice.
  }
}
