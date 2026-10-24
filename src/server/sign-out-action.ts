"use server";

import { signOut } from "@/server/auth";

/**
 * Ends the session and returns to the home page — the same call the Sign out
 * button on /profile makes. Kept in its own server-function file so the site
 * header (a client component) can use it as a form action. Besides removing
 * the cookie, Auth.js's signOut event ends the session on the server (a copy
 * of the cookie stops working), clears the chosen delivery location, sets an
 * online rider offline and records the sign-out: see auth-sessions.ts.
 */
export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}
