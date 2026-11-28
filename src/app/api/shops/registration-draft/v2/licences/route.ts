/**
 * docs/onboarding-v2-2026-11 (Flow 2), step 6 — one required licence answered with one of four options:
 *   ENTER   { licenceKey, option, number, holderName?, validUntil?, issuingAuthority?, consent? }
 *   UPLOAD  multipart: file (PDF / JPG / PNG from files, photos or the camera) + the fields above (optional)
 *   SCAN    multipart: file (the camera photo, optional) + the fields the device's reader filled and the owner confirmed
 *   LATER   { licenceKey, option: "LATER", promise: true } — not for a MUST_HAVE licence (DEFAULT #12)
 * JSON or multipart/form-data; POST so a number never lands in a URL. Answers with the whole wizard.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { UPLOAD_REQUEST_LIMIT_BYTES, fileTooLargeMessage } from "@/lib/document-upload-limits";
import { validationFailed } from "@/lib/errors";
import { LICENCE_OPTIONS } from "@/server/db/schema";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { wizardActor } from "@/server/api/wizard-actor";
import { saveLicenceEntry } from "@/server/onboarding-v2/shop-flow";

export const dynamic = "force-dynamic";

const fieldsSchema = z.object({
  licenceKey: z.string().trim().min(2).max(70),
  option: z.enum(LICENCE_OPTIONS),
  number: z.string().trim().max(60).nullish(),
  holderName: z.string().trim().max(120).nullish(),
  validUntil: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker.")
    .nullish()
    .or(z.literal("").transform(() => null)),
  issuingAuthority: z.string().trim().max(120).nullish(),
  consent: z.boolean().optional(),
  promise: z.boolean().optional(),
  /** Owner, 28-Nov-2026: the number is expired — "I will renew it and upload the new one within <N> days". */
  renewalPromise: z.boolean().optional(),
  ocr: z.record(z.string(), z.string().max(500).nullable()).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await wizardActor(request);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > UPLOAD_REQUEST_LIMIT_BYTES) throw validationFailed(fileTooLargeMessage(UPLOAD_REQUEST_LIMIT_BYTES));
    const form = await request.formData().catch(() => null);
    if (!form) throw validationFailed("Attach the document — upload a file or take a photo.");
    const text = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" && v.trim() ? v : null;
    };
    const ocrRaw = text("ocr");
    let ocr: unknown = null;
    try {
      ocr = ocrRaw ? JSON.parse(ocrRaw) : null;
    } catch {
      ocr = null;
    }
    const parsed = fieldsSchema.safeParse({
      licenceKey: text("licenceKey"),
      option: text("option"),
      number: text("number"),
      holderName: text("holderName"),
      validUntil: text("validUntil"),
      issuingAuthority: text("issuingAuthority"),
      consent: text("consent") === "true",
      promise: text("promise") === "true",
      renewalPromise: text("renewalPromise") === "true",
      ocr,
    });
    if (!parsed.success) throw validationFailed("Please check the highlighted fields.");
    const file = form.get("file");
    return ok(
      await saveLicenceEntry(user, {
        ...parsed.data,
        file: file instanceof File && file.size > 0 ? { data: Buffer.from(await file.arrayBuffer()), source: text("source") === "CAMERA" ? "CAMERA" : "FILE" } : null,
        ip,
      }),
    );
  }
  const body = await parseBody(request, fieldsSchema);
  return ok(await saveLicenceEntry(user, { ...body, file: null, ip }));
});
