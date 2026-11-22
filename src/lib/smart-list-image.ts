/**
 * Browser-side preparation of a list photo before upload (docs/smart-shopping-2026-11, Feature 1 §1):
 * orientation fixed (EXIF), extra rotation by the user, auto-crop to the written area, scaled to at most
 * 2000 px and compressed to JPEG. Falls back to the original file when the browser can't decode it
 * (e.g. HEIC on desktop Chrome) — the server re-encodes anyway. Browser only.
 */

const MAX_SIDE = 2000;

/** Bounding box of the written area: rows/columns with enough "ink" (pixels darker than the page). */
function inkBox(data: Uint8ClampedArray, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  const lum = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    const v = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    lum[i] = v;
    sum += v;
  }
  const threshold = sum / (w * h) - 45;
  const rows = new Array<number>(h).fill(0);
  const cols = new Array<number>(w).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (lum[y * w + x] < threshold) {
        rows[y]++;
        cols[x]++;
      }
    }
  }
  const rowMin = Math.max(1, w * 0.01);
  const colMin = Math.max(1, h * 0.01);
  const ys = rows.map((n, i) => (n >= rowMin ? i : -1)).filter((i) => i >= 0);
  const xs = cols.map((n, i) => (n >= colMin ? i : -1)).filter((i) => i >= 0);
  if (ys.length === 0 || xs.length === 0) return null;
  const pad = 0.04;
  const x0 = Math.max(0, xs[0] - w * pad);
  const x1 = Math.min(w, xs[xs.length - 1] + w * pad);
  const y0 = Math.max(0, ys[0] - h * pad);
  const y1 = Math.min(h, ys[ys.length - 1] + h * pad);
  const box = { x: x0 / w, y: y0 / h, w: (x1 - x0) / w, h: (y1 - y0) / h };
  // Not worth cropping (almost the whole photo), or suspiciously small (noise): keep the photo as it is.
  if (box.w * box.h > 0.9 || box.w * box.h < 0.15) return null;
  return box;
}

export async function prepareListPhoto(file: File, extraRotation: 0 | 90 | 180 | 270 = 0): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  const rotated = extraRotation === 90 || extraRotation === 270;
  const srcW = rotated ? bitmap.height : bitmap.width;
  const srcH = rotated ? bitmap.width : bitmap.height;

  // 1. Draw rotated at a small size to find the written area.
  const probeScale = Math.min(1, 240 / Math.max(srcW, srcH));
  const probe = document.createElement("canvas");
  probe.width = Math.max(1, Math.round(srcW * probeScale));
  probe.height = Math.max(1, Math.round(srcH * probeScale));
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  if (!pctx) return file;
  drawRotated(pctx, bitmap, probe.width, probe.height, extraRotation);
  const box = inkBox(pctx.getImageData(0, 0, probe.width, probe.height).data, probe.width, probe.height) ?? { x: 0, y: 0, w: 1, h: 1 };

  // 2. Draw rotated at full size, then copy the cropped, scaled area.
  const full = document.createElement("canvas");
  full.width = srcW;
  full.height = srcH;
  const fctx = full.getContext("2d");
  if (!fctx) return file;
  drawRotated(fctx, bitmap, srcW, srcH, extraRotation);
  const cw = Math.round(srcW * box.w);
  const ch = Math.round(srcH * box.h);
  const scale = Math.min(1, MAX_SIDE / Math.max(cw, ch));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(cw * scale));
  out.height = Math.max(1, Math.round(ch * scale));
  const octx = out.getContext("2d");
  if (!octx) return file;
  octx.drawImage(full, Math.round(srcW * box.x), Math.round(srcH * box.y), cw, ch, 0, 0, out.width, out.height);
  bitmap.close();
  return new Promise((resolve) => out.toBlob((b) => resolve(b ?? file), "image/jpeg", 0.85));
}

function drawRotated(ctx: CanvasRenderingContext2D, img: ImageBitmap, w: number, h: number, deg: number) {
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((deg * Math.PI) / 180);
  const rotated = deg === 90 || deg === 270;
  const dw = rotated ? h : w;
  const dh = rotated ? w : h;
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}
