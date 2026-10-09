"use server";

import { refresh } from "next/cache";
import { cookies } from "next/headers";

import { LANG_COOKIE, LANG_COOKIE_MAX_AGE_SECONDS, parseLang } from "@/lib/board/i18n";

/**
 * The board's EN / हिं / मरा switch. Stores the choice in a cookie (an
 * unknown value is stored as English) and re-renders the page on the server
 * in that language. A form action, so it also works before JavaScript loads.
 */
export async function setLanguageAction(formData: FormData) {
  const lang = parseLang(formData.get("lang"));
  (await cookies()).set(LANG_COOKIE, lang, {
    path: "/",
    maxAge: LANG_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  refresh();
}
