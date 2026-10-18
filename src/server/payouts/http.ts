/** File responses for payout / invoice downloads (batch-2026-10 WS-E). */
import { NextResponse } from "next/server";

export function fileResponse(body: Buffer | string, filename: string, contentType: string): NextResponse {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]+/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
