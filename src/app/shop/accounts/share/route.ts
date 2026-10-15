/**
 * Share target (docs/inventory-accounting-2026-10, Part 4): a bill shared to
 * the installed GoKesari app from WhatsApp, email or Files arrives here as a
 * form POST (see src/app/manifest.ts). It becomes a bill capture for the
 * owner's shop, is read in the background, and the owner lands on it.
 */
import { after, NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/server/authz/guards";
import { ownerShop } from "@/server/accounts/access";
import { createCapture, processCapture } from "@/server/accounts/capture/service";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Behind the host's proxy request.url is the server's own address (0.0.0.0:3000),
// so redirects use the public origin, as the Zoho callback does.
const to = (request: NextRequest, path: string) =>
  NextResponse.redirect(new URL(path, (process.env.AUTH_URL ?? request.nextUrl.origin).replace(/\/$/, "")), 303);

export async function GET(request: NextRequest) {
  return to(request, "/shop/accounts/capture");
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return to(request, "/signin?callbackUrl=/shop/accounts/capture");
  const shop = await ownerShop(user.id);
  if (!shop) return to(request, "/shop");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return to(request, "/shop/accounts/capture?shared=none");
  }
  const files = [];
  for (const value of form.getAll("file")) {
    if (typeof value === "string") continue;
    files.push({ bytes: Buffer.from(await value.arrayBuffer()), contentType: value.type || null, name: value.name || null });
  }
  if (files.length === 0) return to(request, "/shop/accounts/capture?shared=none");
  try {
    const capture = await createCapture(shop.id, { files: files.slice(0, 10), kind: "SOFT", source: "SHARE" }, user.id);
    after(() => processCapture(capture.id).then(() => undefined));
    return to(request, `/shop/accounts/bills/${capture.id}`);
  } catch {
    return to(request, "/shop/accounts/capture?shared=unsupported");
  }
}
