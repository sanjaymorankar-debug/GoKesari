/**
 * Fonts and the letterhead watermark for the in-site agreement viewer (docs/seller-agreements-2026-11).
 * Public, read-only, only the bundled files (SIL OFL fonts, AGT letterhead images).
 */
import fs from "node:fs";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { LEGAL_ASSETS_DIR } from "@/server/legal-agreements/pdf/browser";

export const dynamic = "force-dynamic";

const ALLOWED: Record<string, string> = {
  "fonts/NotoSans-Regular.ttf": "font/ttf",
  "fonts/NotoSans-Bold.ttf": "font/ttf",
  "fonts/NotoSans-Italic.ttf": "font/ttf",
  "fonts/NotoSansDevanagari-Regular.ttf": "font/ttf",
  "fonts/NotoSansDevanagari-Bold.ttf": "font/ttf",
  "agt-watermark.png": "image/png",
  "agt-logo.png": "image/png",
};

export async function GET(_request: NextRequest, context: { params: Promise<{ name: string[] }> }) {
  const name = (await context.params).name.join("/");
  const type = ALLOWED[name];
  if (!type) return new NextResponse("Not found", { status: 404 });
  const data = fs.readFileSync(path.join(LEGAL_ASSETS_DIR, name));
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=604800, immutable",
      // The viewer frame is sandboxed (opaque origin): fonts load only with CORS.
      "Access-Control-Allow-Origin": "*",
    },
  });
}
