/**
 * Bill scanner — the browser half: turning photo files into pixel buffers and
 * pixel buffers back into small JPEGs, with <canvas>. The pixel work itself is
 * in ./document-scan.ts (DOM-free, tested in node).
 *
 * Phone photos are 3–12 MB with an EXIF orientation tag. They are decoded with
 * the orientation applied (createImageBitmap "from-image", falling back to a
 * plain createImageBitmap, then to an <img>, which modern browsers also orient)
 * and scaled down on the way in. Pages go out as JPEGs aimed at under ~400 KB,
 * so a multi-page bill still uploads on a weak 3G connection.
 *
 * Client-only: every function here needs `document`.
 */
import type { Rgba } from "@/lib/scan/document-scan";

/** Each page's JPEG aims to stay under this size. */
export const TARGET_JPEG_BYTES = 400_000;
/** Quality is never lowered below this; the page is made smaller instead. */
const MIN_QUALITY = 0.55;
/** …and never smaller than this on its long side, whatever the byte count. */
const MIN_SIDE = 1000;

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    for (const options of [{ imageOrientation: "from-image" } as ImageBitmapOptions, undefined]) {
      try {
        const bitmap = options ? await createImageBitmap(file, options) : await createImageBitmap(file);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
      } catch {
        // Older WebViews reject the options object (or Blob input entirely): try the next way.
      }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("This photo could not be opened."));
      img.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot process photos (no canvas).");
  return ctx;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Decodes a photo (EXIF orientation applied), long side scaled down to maxSide. */
export async function loadImageFile(file: File | Blob, maxSide = 2400): Promise<Rgba> {
  const decoded = await decode(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error("This photo could not be opened.");
    const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = makeCanvas(width, height);
    const ctx = context2d(canvas);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    canvas.width = 0; // let the browser free the backing store now (helps low-memory phones)
    return { width, height, data };
  } finally {
    decoded.release();
  }
}

/** Paints a pixel buffer onto a new canvas, optionally scaled down to maxSide. */
export function rgbaToCanvas(img: Rgba, maxSide?: number): HTMLCanvasElement {
  const full = makeCanvas(img.width, img.height);
  const ctx = context2d(full);
  const imageData = ctx.createImageData(img.width, img.height);
  imageData.data.set(img.data);
  ctx.putImageData(imageData, 0, 0);
  if (!maxSide || Math.max(img.width, img.height) <= maxSide) return full;
  return resizeCanvas(full, maxSide);
}

function resizeCanvas(source: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const out = makeCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)));
  const ctx = context2d(out);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out;
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not save the page as JPEG."))), "image/jpeg", quality);
  });
}

/**
 * JPEG of the page, long side at most maxSide, aiming for targetBytes: when
 * too big, quality steps down to 0.55, then the page shrinks (to 1000 px at
 * the least). Returns the final size so callers know what they upload.
 */
export async function encodeJpeg(
  img: Rgba,
  quality = 0.82,
  maxSide = 1800,
  targetBytes = TARGET_JPEG_BYTES,
): Promise<{ blob: Blob; width: number; height: number }> {
  const full = rgbaToCanvas(img);
  let side = Math.min(maxSide, Math.max(img.width, img.height));
  let canvas = resizeCanvas(full, side);
  let q = quality;
  for (;;) {
    const blob = await canvasToJpeg(canvas, q);
    if (blob.size <= targetBytes) return { blob, width: canvas.width, height: canvas.height };
    if (q > MIN_QUALITY + 0.001) {
      q = Math.max(MIN_QUALITY, q - 0.1);
      continue;
    }
    const nextSide = Math.round(side * 0.85);
    if (nextSide < MIN_SIDE || side <= MIN_SIDE) return { blob, width: canvas.width, height: canvas.height };
    side = nextSide;
    canvas = resizeCanvas(full, side);
    q = Math.min(quality, 0.7);
  }
}

/** The page as a JPEG Blob for upload (see encodeJpeg for the size targeting). */
export async function rgbaToJpegBlob(img: Rgba, quality = 0.82, maxSide = 1800): Promise<Blob> {
  return (await encodeJpeg(img, quality, maxSide)).blob;
}

/** A small JPEG data URL, for thumbnails. */
export function rgbaToDataUrl(img: Rgba, maxSide = 320, quality = 0.7): string {
  return rgbaToCanvas(img, maxSide).toDataURL("image/jpeg", quality);
}

/**
 * Lets the browser paint (a progress message, a spinner) between heavy steps.
 * Waits for the next frame, but no longer than 50 ms — frames stop while the
 * page is hidden (e.g. the camera app is still closing), and work must go on.
 */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setTimeout(resolve, 0);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
}
