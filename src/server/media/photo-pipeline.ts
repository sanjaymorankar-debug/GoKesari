/**
 * Product photo processing (Module 1, docs/three-modules-2026-10).
 *
 * Every photo a shop uploads is checked and rebuilt on the server, whatever the
 * browser did first:
 *   1. size ≤ the configured maximum (5 MB by default);
 *   2. real type from the file's own bytes (JPEG, PNG or WebP — never the name
 *      or the declared type), confirmed again by the image decoder so a file
 *      that only starts like an image is refused;
 *   3. a pixel-count ceiling before anything is decoded (decompression bombs);
 *   4. the camera's EXIF orientation applied, then ALL metadata dropped — GPS
 *      position, camera model, timestamps, comments (sharp writes none unless
 *      asked to);
 *   5. three WebP copies: thumbnail, medium and large (longest side, never
 *      enlarged). The original file is not kept.
 */
import { createHash } from "node:crypto";

import sharp, { type Metadata } from "sharp";

import { validationFailed } from "@/lib/errors";
import { detectImage } from "@/server/services/image-store";

export interface PhotoLimits {
  maxUploadBytes: number;
  minDimensionPx: number;
  maxInputPixels: number;
  thumbPx: number;
  mediumPx: number;
  largePx: number;
  webpQuality: number;
}

export interface ProcessedVariant {
  data: Buffer;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface ProcessedPhoto {
  large: ProcessedVariant;
  medium: ProcessedVariant;
  thumb: ProcessedVariant;
  /** sha256 of the large WebP. */
  sha256: string;
  source: { contentType: string; width: number; height: number; bytes: number };
}

const FORMAT_TYPES: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;

/** Refusal reasons, so callers (and the bulk upload) can report them per file. */
export const PHOTO_ERRORS = {
  EMPTY: "PHOTO_EMPTY",
  TOO_LARGE: "PHOTO_TOO_LARGE",
  BAD_TYPE: "PHOTO_BAD_TYPE",
  UNREADABLE: "PHOTO_UNREADABLE",
  TOO_SMALL: "PHOTO_TOO_SMALL",
  TOO_MANY_PIXELS: "PHOTO_TOO_MANY_PIXELS",
} as const;

/** Cheap checks that need no decoding: size and real type. Throws a 422 with a reason code. */
export function precheckPhoto(input: Buffer, limits: Pick<PhotoLimits, "maxUploadBytes">): { contentType: string } {
  if (input.length === 0) throw validationFailed("The photo file is empty.", { reason: PHOTO_ERRORS.EMPTY });
  if (input.length > limits.maxUploadBytes) {
    throw validationFailed(`Each photo can be at most ${megabytes(limits.maxUploadBytes)}.`, {
      reason: PHOTO_ERRORS.TOO_LARGE,
      maxBytes: limits.maxUploadBytes,
    });
  }
  const detected = detectImage(input);
  if (!detected) {
    throw validationFailed("Upload a JPG, PNG or WebP photo.", { reason: PHOTO_ERRORS.BAD_TYPE });
  }
  return { contentType: detected.contentType };
}

async function render(input: Buffer, px: number, limits: PhotoLimits): Promise<ProcessedVariant> {
  const { data, info } = await sharp(input, { limitInputPixels: limits.maxInputPixels, failOn: "error" })
    .rotate()
    .resize({ width: px, height: px, fit: "inside", withoutEnlargement: true })
    .webp({ quality: limits.webpQuality })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, sizeBytes: data.length };
}

export async function processProductPhoto(input: Buffer, limits: PhotoLimits): Promise<ProcessedPhoto> {
  const { contentType } = precheckPhoto(input, limits);

  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: limits.maxInputPixels, failOn: "error" }).metadata();
  } catch {
    throw validationFailed("This photo could not be read. Take or choose it again.", { reason: PHOTO_ERRORS.UNREADABLE });
  }
  // The decoder must agree with the bytes we sniffed: a PNG header on a file
  // that is really something else is refused.
  if (!meta.format || FORMAT_TYPES[meta.format] !== contentType) {
    throw validationFailed("Upload a JPG, PNG or WebP photo.", { reason: PHOTO_ERRORS.BAD_TYPE });
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width * height > limits.maxInputPixels) {
    throw validationFailed("This photo has too many pixels. Use a smaller photo.", { reason: PHOTO_ERRORS.TOO_MANY_PIXELS });
  }
  if (Math.min(width, height) < limits.minDimensionPx) {
    throw validationFailed(`The photo is too small — at least ${limits.minDimensionPx} px on each side.`, {
      reason: PHOTO_ERRORS.TOO_SMALL,
    });
  }

  let large: ProcessedVariant;
  let medium: ProcessedVariant;
  let thumb: ProcessedVariant;
  try {
    large = await render(input, limits.largePx, limits);
    medium = await render(input, limits.mediumPx, limits);
    thumb = await render(input, limits.thumbPx, limits);
  } catch {
    throw validationFailed("This photo could not be read. Take or choose it again.", { reason: PHOTO_ERRORS.UNREADABLE });
  }

  return {
    large,
    medium,
    thumb,
    sha256: createHash("sha256").update(large.data).digest("hex"),
    source: { contentType, width, height, bytes: input.length },
  };
}
