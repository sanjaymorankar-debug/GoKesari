/**
 * Document scanning for paper supplier bills — the pure, DOM-free half.
 *
 * A shop owner photographs a paper bill lying on the counter. This module
 * finds the sheet in the photo, cuts it out and straightens it (perspective
 * correction), then cleans it up so the print reads well after heavy JPEG
 * compression on a slow network. Everything works on plain pixel buffers, so
 * it runs (and is tested) in node exactly as it runs in the browser; the
 * canvas glue lives in ./browser.ts.
 *
 * Coordinates are continuous pixel coordinates: pixel (i, j) covers the square
 * [i, i+1) × [j, j+1), so the full-image quad is (0,0) (W,0) (W,H) (0,H).
 *
 * Detection (detectDocument), designed for a white bill on a darker table:
 *   1. downscale to ~400 px and blur, so print and camera noise disappear;
 *   2. Otsu threshold — the paper is the bright class;
 *   3. a 3×3 opening cuts thin bright bridges to other objects, then the
 *      largest bright connected component is taken as the paper and its holes
 *      (the printed text) are filled;
 *   4. the component's outline is reduced to its convex hull and then to the
 *      four-cornered polygon that loses the least area (works at any
 *      rotation, unlike plain x+y / x−y extremes);
 *   5. each side is refined by a total-least-squares line fit through the
 *      outline points along it, and the corners become the line intersections
 *      (so rounded or dog-eared corners do not pull the crop inwards).
 * Confidence combines how well the quad matches the filled component, how big
 * it is in the frame, and the paper/table contrast. Anything doubtful returns
 * null and the caller keeps the whole photo.
 */

export interface Gray {
  width: number;
  height: number;
  /** One byte per pixel. */
  data: Uint8ClampedArray;
}

export interface Rgba {
  width: number;
  height: number;
  /** Four bytes per pixel, row-major — the same layout as ImageData. */
  data: Uint8ClampedArray;
}

export type Point = { x: number; y: number };

/** Top-left, top-right, bottom-right, bottom-left, in source pixel coordinates. */
export type Quad = [Point, Point, Point, Point];

export type EnhanceMode = "color" | "gray" | "bw";

/** Long side detection works at: plenty for finding a sheet, and fast on any phone. */
export const DETECT_SIZE = 400;
/** A quad covering less of the frame than this is not trusted as "the bill". */
export const MIN_AREA_FRACTION = 0.15;
/** Below this confidence detectDocument returns null. */
export const MIN_CONFIDENCE = 0.5;
/** warpPerspective never produces a long side above this unless asked to explicitly. */
export const MAX_WARP_SIDE = 2000;
/**
 * Variance of the Laplacian below which a page is probably too blurred to read.
 * Measured on the straightened page scaled to SHARPNESS_SIZE on its long side
 * (see estimateSharpness); sharp printed bills score in the hundreds to
 * thousands, shaken or out-of-focus ones in the tens.
 */
export const BLUR_THRESHOLD = 50;
/** Long side the bill scanner scales a page to before estimateSharpness, so scores compare across photos. */
export const SHARPNESS_SIZE = 1200;

/* ----------------------------------------------------------- basic ops */

/** Luma (ITU-R BT.601), one byte per pixel. */
export function toGray(img: Rgba): Gray {
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n);
  const src = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (src[j] * 299 + src[j + 1] * 587 + src[j + 2] * 114 + 500) / 1000;
  }
  return { width: img.width, height: img.height, data: out };
}

/**
 * Area-average downscale so the long side is at most maxSide. `scale` is the
 * factor applied (≤ 1); an image already small enough is returned as is.
 */
export function downscale(img: Rgba, maxSide: number): { img: Rgba; scale: number } {
  const long = Math.max(img.width, img.height);
  if (long <= maxSide || long === 0) return { img, scale: 1 };
  const scale = maxSide / long;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const x0s = new Int32Array(w);
  const x1s = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    x0s[x] = Math.floor((x * img.width) / w);
    x1s[x] = Math.max(x0s[x] + 1, Math.floor(((x + 1) * img.width) / w));
  }
  const out = new Uint8ClampedArray(w * h * 4);
  const src = img.data;
  const stride = img.width * 4;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const xa = x0s[x];
      const xb = x1s[x];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = yy * stride + xa * 4;
        for (let xx = xa; xx < xb; xx++, p += 4) {
          r += src[p];
          g += src[p + 1];
          b += src[p + 2];
          a += src[p + 3];
        }
      }
      const count = (y1 - y0) * (xb - xa);
      const o = (y * w + x) * 4;
      out[o] = r / count;
      out[o + 1] = g / count;
      out[o + 2] = b / count;
      out[o + 3] = a / count;
    }
  }
  return { img: { width: w, height: h, data: out }, scale };
}

/** Separable box blur with the given radius (edges clamp). */
function boxBlur(g: Gray, radius: number): Gray {
  const { width: w, height: h } = g;
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  const size = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += g.data[row + clampInt(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / size;
      sum += g.data[row + clampInt(x + radius + 1, 0, w - 1)] - g.data[row + clampInt(x - radius, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[clampInt(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / size;
      sum += tmp[clampInt(y + radius + 1, 0, h - 1) * w + x] - tmp[clampInt(y - radius, 0, h - 1) * w + x];
    }
  }
  return { width: w, height: h, data: out };
}

/** Otsu's threshold, plus the two class means (for a contrast check). */
function otsu(g: Gray): { threshold: number; lowMean: number; highMean: number } {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.data.length; i++) hist[g.data[i]]++;
  const total = g.data.length;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * hist[v];
  let wLow = 0;
  let sumLow = 0;
  let best = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wLow += hist[t];
    if (wLow === 0) continue;
    const wHigh = total - wLow;
    if (wHigh === 0) break;
    sumLow += t * hist[t];
    const mLow = sumLow / wLow;
    const mHigh = (sumAll - sumLow) / wHigh;
    const between = wLow * wHigh * (mLow - mHigh) * (mLow - mHigh);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  let lowCount = 0;
  let lowSum = 0;
  for (let v = 0; v <= threshold; v++) {
    lowCount += hist[v];
    lowSum += v * hist[v];
  }
  const highCount = total - lowCount;
  return {
    threshold,
    lowMean: lowCount ? lowSum / lowCount : 0,
    highMean: highCount ? (sumAll - lowSum) / highCount : 255,
  };
}

/** 3×3 erosion (dilate = false) or dilation of a 0/1 mask; outside the image counts as 0. */
function morph(mask: Uint8Array, w: number, h: number, dilate: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = dilate ? 0 : 1;
      for (let dy = -1; dy <= 1 && hit === (dilate ? 0 : 1); dy++) {
        const yy = y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const v = yy < 0 || yy >= h || xx < 0 || xx >= w ? 0 : mask[yy * w + xx];
          if (dilate ? v === 1 : v === 0) {
            hit = dilate ? 1 : 0;
            break;
          }
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

/** Labels of the largest 4-connected component of 1s, as a 0/1 mask, with its area. */
function largestComponent(mask: Uint8Array, w: number, h: number): { mask: Uint8Array; area: number } | null {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let next = 0;
  let bestLabel = 0;
  let bestArea = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = ++next;
    let top = 0;
    let area = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top > 0) {
      const p = stack[--top];
      area++;
      const x = p % w;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) {
        labels[p - 1] = label;
        stack[top++] = p - 1;
      }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) {
        labels[p + 1] = label;
        stack[top++] = p + 1;
      }
      if (p >= w && mask[p - w] && !labels[p - w]) {
        labels[p - w] = label;
        stack[top++] = p - w;
      }
      if (p < w * (h - 1) && mask[p + w] && !labels[p + w]) {
        labels[p + w] = label;
        stack[top++] = p + w;
      }
    }
    if (area > bestArea) {
      bestArea = area;
      bestLabel = label;
    }
  }
  if (!bestLabel) return null;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = labels[i] === bestLabel ? 1 : 0;
  return { mask: out, area: bestArea };
}

/** Fills holes (regions of 0 not connected to the border) in place; returns the filled area. */
function fillHoles(mask: Uint8Array, w: number, h: number): number {
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const seed = (p: number) => {
    if (!mask[p] && !outside[p]) {
      outside[p] = 1;
      stack[top++] = p;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (top > 0) {
    const p = stack[--top];
    const x = p % w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < w * (h - 1)) seed(p + w);
  }
  let area = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!outside[i]) {
      mask[i] = 1;
      area++;
    }
  }
  return area;
}

/** Outline samples: per-row leftmost/rightmost and per-column topmost/bottommost edges of the mask. */
function outlinePoints(mask: Uint8Array, w: number, h: number): Point[] {
  const pts: Point[] = [];
  for (let y = 0; y < h; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    if (lo >= 0) {
      pts.push({ x: lo, y: y + 0.5 }, { x: hi + 1, y: y + 0.5 });
    }
  }
  for (let x = 0; x < w; x++) {
    let lo = -1;
    let hi = -1;
    for (let y = 0; y < h; y++) {
      if (mask[y * w + x]) {
        if (lo < 0) lo = y;
        hi = y;
      }
    }
    if (lo >= 0) {
      pts.push({ x: x + 0.5, y: lo }, { x: x + 0.5, y: hi + 1 });
    }
  }
  return pts;
}

/* ------------------------------------------------------------ geometry */

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Monotone-chain convex hull, returned clockwise on screen (y down). */
function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Greedily drops the hull vertex whose removal loses the least area until four remain. */
function reduceToFour(hull: Point[]): Point[] {
  const pts = [...hull];
  while (pts.length > 4) {
    let bestIdx = 0;
    let bestArea = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const next = pts[(i + 1) % pts.length];
      const area = Math.abs(cross(prev, pts[i], next));
      if (area < bestArea) {
        bestArea = area;
        bestIdx = i;
      }
    }
    pts.splice(bestIdx, 1);
  }
  return pts;
}

export function polygonArea(points: Point[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/**
 * Orders four corners as TL, TR, BR, BL (clockwise on screen, starting from
 * the corner nearest the image's top-left). With more than four points the
 * outermost ones along the diagonals are used.
 */
export function orderQuad(points: Point[]): Quad {
  if (points.length < 4) throw new Error("orderQuad needs at least four points");
  let pts = points;
  if (points.length > 4) {
    const by = (f: (p: Point) => number, max: boolean) =>
      points.reduce((best, p) => ((max ? f(p) > f(best) : f(p) < f(best)) ? p : best), points[0]);
    pts = [by((p) => p.x + p.y, false), by((p) => p.x - p.y, true), by((p) => p.x + p.y, true), by((p) => p.x - p.y, false)];
  }
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  // atan2 grows clockwise on screen because y points down.
  const sorted = [...pts.slice(0, 4)].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  }
  const q = [0, 1, 2, 3].map((k) => ({ ...sorted[(start + k) % 4] }));
  return [q[0], q[1], q[2], q[3]];
}

/** The quad covering a whole image. */
export function fullQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

/** Total-least-squares line through points: a point on it and its unit direction. */
function fitLine(points: Point[]): { p: Point; d: Point } | null {
  if (points.length < 2) return null;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= points.length;
  my /= points.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: { x: mx, y: my }, d: { x: Math.cos(angle), y: Math.sin(angle) } };
}

function intersect(a: { p: Point; d: Point }, b: { p: Point; d: Point }): Point | null {
  const den = a.d.x * b.d.y - a.d.y * b.d.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / den;
  return { x: a.p.x + t * a.d.x, y: a.p.y + t * a.d.y };
}

/** Moves each corner to the intersection of lines fitted to the outline along its two sides. */
function refineCorners(quad: Quad, outline: Point[], diag: number): Quad {
  const tol = Math.max(1.5, diag * 0.02);
  const lines: ({ p: Point; d: Point } | null)[] = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const len = dist(a, b);
    if (len < 1) {
      lines.push(null);
      continue;
    }
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const near: Point[] = [];
    for (const p of outline) {
      const t = ((p.x - a.x) * ux + (p.y - a.y) * uy) / len;
      if (t < 0.12 || t > 0.88) continue;
      const off = Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux);
      if (off <= tol) near.push(p);
    }
    lines.push(near.length >= 6 ? fitLine(near) : null);
  }
  const out = quad.map((c, i) => {
    const prev = lines[(i + 3) % 4];
    const next = lines[i];
    if (!prev || !next) return c;
    const hit = intersect(prev, next);
    return hit && dist(hit, c) <= diag * 0.08 ? hit : c;
  });
  return [out[0], out[1], out[2], out[3]];
}

/** Interior angles all within [minDeg, 180 − minDeg] and the quad convex. */
function isReasonableQuad(q: Quad, minDeg: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const prev = q[(i + 3) % 4];
    const cur = q[i];
    const next = q[(i + 1) % 4];
    const c = cross(prev, cur, next);
    if (c === 0) return false;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
    const v1x = prev.x - cur.x;
    const v1y = prev.y - cur.y;
    const v2x = next.x - cur.x;
    const v2y = next.y - cur.y;
    const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y));
    const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (deg < minDeg || deg > 180 - minDeg) return false;
  }
  return true;
}

/* ------------------------------------------------------------ detection */

/** Finds the paper: returns a quad or null if no confident document. */
export function detectDocument(img: Rgba): { quad: Quad; confidence: number } | null {
  if (img.width < 16 || img.height < 16) return null;
  const { img: small } = downscale(img, DETECT_SIZE);
  const w = small.width;
  const h = small.height;
  const sx = img.width / w;
  const sy = img.height / h;
  const gray = boxBlur(toGray(small), 2);
  const { threshold, lowMean, highMean } = otsu(gray);
  const contrast = highMean - lowMean;
  if (contrast < 25) return null;

  let mask: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = gray.data[i] > threshold ? 1 : 0;
  mask = morph(morph(mask, w, h, false), w, h, true);
  const comp = largestComponent(mask, w, h);
  if (!comp) return null;
  const filledArea = fillHoles(comp.mask, w, h);
  const imageArea = w * h;
  if (filledArea < imageArea * MIN_AREA_FRACTION) return null;

  const outline = outlinePoints(comp.mask, w, h);
  const hull = convexHull(outline);
  if (hull.length < 4) return null;
  const diag = Math.hypot(w, h);
  let quad = orderQuad(reduceToFour(hull));
  quad = refineCorners(quad, outline, diag);
  for (const p of quad) {
    p.x = Math.min(w, Math.max(0, p.x));
    p.y = Math.min(h, Math.max(0, p.y));
  }
  if (!isReasonableQuad(quad, 30)) return null;
  for (let i = 0; i < 4; i++) if (dist(quad[i], quad[(i + 1) % 4]) < diag * 0.1) return null;

  const quadArea = polygonArea(quad);
  const areaFraction = quadArea / imageArea;
  if (areaFraction < MIN_AREA_FRACTION) return null;
  // The bright region is (almost) the whole frame: nothing to crop, or a bright table.
  if (areaFraction > 0.97) return null;

  const fill = filledArea / quadArea;
  const fit = Math.min(fill, 1 / fill);
  const fitScore = clamp((fit - 0.8) / 0.15, 0, 1);
  if (fitScore === 0) return null;
  const sizeScore = clamp((areaFraction - MIN_AREA_FRACTION) / 0.2, 0, 1);
  const contrastScore = clamp((contrast - 25) / 50, 0, 1);
  const confidence = Math.round((0.6 * fitScore + 0.2 * sizeScore + 0.2 * contrastScore) * 1000) / 1000;
  if (confidence < MIN_CONFIDENCE) return null;

  const scaled = quad.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  return { quad: [scaled[0], scaled[1], scaled[2], scaled[3]], confidence };
}

/* ------------------------------------------------------------- warping */

/**
 * The 3×3 projective transform (row-major, h[8] = 1) taking each src corner to
 * the matching dst corner.
 */
export function homography(src: Quad, dst: Quad): number[] {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error("Degenerate quad: corners must not be collinear");
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let c = col; c < 9; c++) a[r][c] -= f * a[col][c];
    }
  }
  const h = a.map((row, i) => row[8] / row[i]);
  h.push(1);
  return h;
}

/** Applies a row-major 3×3 homography to a point. */
export function applyHomography(h: number[], p: Point): Point {
  const den = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / den, y: (h[3] * p.x + h[4] * p.y + h[5]) / den };
}

/** Output size for a quad: the longer of each pair of opposite edges, long side capped at MAX_WARP_SIDE. */
export function warpSize(quad: Quad): { width: number; height: number } {
  const width = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
  const height = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
  const k = Math.min(1, MAX_WARP_SIDE / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/**
 * Cuts the quad out of img and straightens it into a width × height rectangle
 * (bilinear sampling). When a size is omitted it follows the quad's edge
 * lengths (and the other given side's aspect), long side capped at 2000.
 */
export function warpPerspective(img: Rgba, quad: Quad, outWidth?: number, outHeight?: number): Rgba {
  const natural = warpSize(quad);
  let width = natural.width;
  let height = natural.height;
  if (outWidth && outHeight) {
    width = outWidth;
    height = outHeight;
  } else if (outWidth) {
    width = outWidth;
    height = Math.max(1, Math.round((outWidth * natural.height) / natural.width));
  } else if (outHeight) {
    height = outHeight;
    width = Math.max(1, Math.round((outHeight * natural.width) / natural.height));
  }
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));

  const h = homography(fullQuad(width, height), quad);
  const out = new Uint8ClampedArray(width * height * 4);
  const src = img.data;
  const sw = img.width;
  const sh = img.height;
  const maxX = sw - 1;
  const maxY = sh - 1;
  let o = 0;
  for (let y = 0; y < height; y++) {
    const Y = y + 0.5;
    let nx = h[0] * 0.5 + h[1] * Y + h[2];
    let ny = h[3] * 0.5 + h[4] * Y + h[5];
    let d = h[6] * 0.5 + h[7] * Y + h[8];
    for (let x = 0; x < width; x++, o += 4) {
      // Source position in pixel-centre coordinates.
      let fx = nx / d - 0.5;
      let fy = ny / d - 0.5;
      nx += h[0];
      ny += h[3];
      d += h[6];
      if (fx < 0) fx = 0;
      else if (fx > maxX) fx = maxX;
      if (fy < 0) fy = 0;
      else if (fy > maxY) fy = maxY;
      const x0 = fx | 0;
      const y0 = fy | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const ax = fx - x0;
      const ay = fy - y0;
      const p00 = (y0 * sw + x0) * 4;
      const p10 = (y0 * sw + x1) * 4;
      const p01 = (y1 * sw + x0) * 4;
      const p11 = (y1 * sw + x1) * 4;
      const w00 = (1 - ax) * (1 - ay);
      const w10 = ax * (1 - ay);
      const w01 = (1 - ax) * ay;
      const w11 = ax * ay;
      out[o] = src[p00] * w00 + src[p10] * w10 + src[p01] * w01 + src[p11] * w11;
      out[o + 1] = src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11;
      out[o + 2] = src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/* ------------------------------------------------------------- enhance */

/** Lookup table stretching [1st, 99th] percentile of a histogram to [0, 255]. */
function stretchLut(hist: Uint32Array, total: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const loCount = total * 0.01;
  const hiCount = total * 0.99;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  let foundLo = false;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (!foundLo && acc > loCount) {
      lo = v;
      foundLo = true;
    }
    if (acc >= hiCount) {
      hi = v;
      break;
    }
  }
  if (hi - lo < 16) {
    // Almost flat (a blank page): stretching would only amplify noise.
    for (let v = 0; v < 256; v++) lut[v] = v;
    return lut;
  }
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
  return lut;
}

/**
 * Cleans up a straightened page:
 *   - "color": contrast stretch per channel (1st–99th percentile), which also
 *     white-balances yellowish indoor light so the paper turns white;
 *   - "gray":  luma, then the same stretch;
 *   - "bw":    adaptive threshold against the local mean (integral image,
 *     Bradley–Roth), robust to shadows across the page — crisp for printed
 *     and handwritten bills, and the smallest JPEGs.
 */
export function enhance(img: Rgba, mode: EnhanceMode): Rgba {
  const { width: w, height: h } = img;
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  const src = img.data;

  if (mode === "color") {
    const hists = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < n * 4; i += 4) {
      hists[0][src[i]]++;
      hists[1][src[i + 1]]++;
      hists[2][src[i + 2]]++;
    }
    const luts = hists.map((hist) => stretchLut(hist, n));
    for (let i = 0; i < n * 4; i += 4) {
      out[i] = luts[0][src[i]];
      out[i + 1] = luts[1][src[i + 1]];
      out[i + 2] = luts[2][src[i + 2]];
      out[i + 3] = 255;
    }
    return { width: w, height: h, data: out };
  }

  const gray = toGray(img).data;
  if (mode === "gray") {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[gray[i]]++;
    const lut = stretchLut(hist, n);
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const v = lut[gray[i]];
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = 255;
    }
    return { width: w, height: h, data: out };
  }

  // "bw": integral image of the luma, then compare each pixel with its window mean.
  const iw = w + 1;
  const integral = n * 255 < 2 ** 32 ? new Uint32Array(iw * (h + 1)) : new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * iw + x + 1] = integral[y * iw + x + 1] + rowSum;
    }
  }
  const half = Math.max(7, Math.round(Math.max(w, h) / 48));
  const darker = 0.15; // a pixel this much darker than its surroundings is ink
  const minDiff = 10; // …and at least this many levels darker (keeps flat shadows clean)
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - half);
    const yb = Math.min(h, y + half + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - half);
      const xb = Math.min(w, x + half + 1);
      const count = (yb - ya) * (xb - xa);
      const sum = integral[yb * iw + xb] - integral[ya * iw + xb] - integral[yb * iw + xa] + integral[ya * iw + xa];
      const mean = sum / count;
      const v = gray[y * w + x];
      const ink = v < mean * (1 - darker) && mean - v >= minDiff;
      const o = (y * w + x) * 4;
      const c = ink ? 0 : 255;
      out[o] = c;
      out[o + 1] = c;
      out[o + 2] = c;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Variance of the (4-neighbour) Laplacian of the luma: high for crisp print,
 * low for a shaken or out-of-focus photo. Scores depend on resolution, so the
 * scanner measures pages scaled to SHARPNESS_SIZE and warns below BLUR_THRESHOLD.
 */
export function estimateSharpness(img: Rgba): number {
  const { width: w, height: h } = img;
  if (w < 3 || h < 3) return 0;
  const g = toGray(img).data;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const lap = 4 * g[p] - g[p - 1] - g[p + 1] - g[p - w] - g[p + w];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/* -------------------------------------------------------------- helpers */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
