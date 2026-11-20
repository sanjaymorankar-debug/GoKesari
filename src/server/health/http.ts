/** Small helpers shared by the GoKesari Health API routes. */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import type { RouteContext } from "@/server/api/handler";

export const ipOf = (request: NextRequest) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
export const uuidParam = async <K extends string>(context: RouteContext<Record<K, string>>, key: K): Promise<string> => z.string().uuid().parse((await context.params)[key]);
export async function bodyOf(request: NextRequest): Promise<Record<string, unknown>> {
  return ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}
export const str = (body: Record<string, unknown>, key: string): string | null => (typeof body[key] === "string" ? (body[key] as string) : null);

/** A private file response (PDF / image) — never cached, never sniffed. */
export function fileResponse(data: Buffer, contentType: string, fileName: string, inline = true): NextResponse {
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${fileName.replace(/[^\w.\- ]+/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function fileFromForm(request: NextRequest): Promise<{ form: FormData | null; file: File | null }> {
  const form = await request.formData().catch(() => null);
  const f = form?.get("file");
  return { form, file: f instanceof File && f.size > 0 ? f : null };
}
