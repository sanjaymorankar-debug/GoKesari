import { cookies } from "next/headers";

import { LANG_COOKIE, parseLang, type Lang } from "@/lib/board/i18n";

/** The visitor's board language from the cookie; English when unset or unreadable. */
export async function getBoardLang(): Promise<Lang> {
  try {
    return parseLang((await cookies()).get(LANG_COOKIE)?.value);
  } catch {
    return "en";
  }
}
