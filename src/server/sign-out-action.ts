"use server";

import { signOut } from "@/server/auth";

/**
 * Ends the session and returns to the home page — the same call the Sign out
 * button on /profile makes. Kept in its own server-function file so the site
 * header (a client component) can use it as a form action.
 */
export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}
