import { cache } from "react";
import { cookies } from "next/headers";

import { LANG_COOKIE, parseLang, type Lang } from "@/lib/board/i18n";

/**
 * The signed-in person's saved language (users.preferred_lang, migration
 * 0186), or null when signed out, never chosen or unreadable. Cached for one
 * server render. Imported lazily so pages that never need it (the cookie is
 * set) do not pull the session in.
 */
const savedLang = cache(async (): Promise<Lang | null> => {
  try {
    const { getCurrentUser } = await import("@/server/authz/guards");
    const user = await getCurrentUser();
    if (!user) return null;
    const { getPreferredLang } = await import("@/server/preferred-lang");
    return await getPreferredLang(user.id);
  } catch {
    return null;
  }
});

/**
 * The visitor's board language: the gk_lang cookie first, then the signed-in
 * person's saved choice (a new phone or browser), then English.
 */
export async function getBoardLang(): Promise<Lang> {
  let raw: string | undefined;
  try {
    raw = (await cookies()).get(LANG_COOKIE)?.value;
  } catch {
    return "en";
  }
  if (raw) return parseLang(raw);
  return (await savedLang()) ?? "en";
}
