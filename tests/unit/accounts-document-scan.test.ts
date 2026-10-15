/**
 * Bill scanner algorithms (src/lib/scan/document-scan.ts), on synthetic
 * photos: a white, rotated, slightly perspective-skewed "bill" with dark
 * print, lying on a darker, noisy "table".
 */
import { describe, expect, it } from "vitest";

import {
  applyHomography,
  detectDocument,
  downscale,
  enhance,
  estimateSharpness,
  fullQuad,
  homography,
  orderQuad,
  warpPerspective,
  type Point,
  type Quad,
  type Rgba,
} from "@/lib/scan/document-scan";

/** Deterministic pseudo-random numbers (mulberry32), so failures reproduce. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inside(q: Quad, x: number, y: number): boolean {
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false;
  }
  return true;
}

/** Corners of a w×h rectangle rotated by deg around (cx, cy), TL TR BR BL. */
function rotatedRect(cx: number, cy: number, w: number, h: number, deg: number): Quad {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const pts = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }));
  return [pts[0], pts[1], pts[2], pts[3]];
}

/** An 800×600 photo of the paper quad on a dark table, with text-like dark rectangles on the paper. */
function billPhoto(paper: Quad, width = 800, height = 600, seed = 7): Rgba {
  const rand = rng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  // Paper-space → image-space mapping, to print "text lines" on the sheet.
  const toImage = homography(fullQuad(1, 1), paper);
  const textBoxes: Quad[] = [];
  for (let line = 0; line < 12; line++) {
    const v0 = 0.12 + line * 0.065;
    for (let word = 0; word < 5; word++) {
      const u0 = 0.1 + word * 0.16 + rand() * 0.02;
      const u1 = u0 + 0.08 + rand() * 0.04;
      const v1 = v0 + 0.025;
      textBoxes.push(
        orderQuad([
          applyHomography(toImage, { x: u0, y: v0 }),
          applyHomography(toImage, { x: u1, y: v0 }),
          applyHomography(toImage, { x: u1, y: v1 }),
          applyHomography(toImage, { x: u0, y: v1 }),
        ]),
      );
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const o = (y * width + x) * 4;
      let r: number;
      let g: number;
      let b: number;
      if (inside(paper, px, py)) {
        const ink = textBoxes.some((t) => inside(t, px, py));
        const base = ink ? 35 : 228;
        r = base + 6;
        g = base + 2;
        b = base - 6;
      } else {
        // Brown wooden table with a gentle light gradient.
        const shade = 70 + (x / width) * 25;
        r = shade + 15;
        g = shade;
        b = shade - 20;
      }
      const noise = (rand() - 0.5) * 16;
      data[o] = r + noise;
      data[o + 1] = g + noise;
      data[o + 2] = b + noise;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

function boxBlurRgba(img: Rgba, radius: number): Rgba {
  const { width: w, height: h } = img;
  const out = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0];
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const p = (yy * w + xx) * 4;
          acc[0] += img.data[p];
          acc[1] += img.data[p + 1];
          acc[2] += img.data[p + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = acc[0] / n;
      out[o + 1] = acc[1] / n;
      out[o + 2] = acc[2] / n;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

function meanLuma(img: Rgba, x0: number, y0: number, x1: number, y1: number): number {
  let s = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * img.width + x) * 4;
      s += 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
      n++;
    }
  }
  return s / n;
}

function expectCornersNear(found: Quad, truth: Quad, tolerance: number) {
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(found[i].x - truth[i].x, found[i].y - truth[i].y);
    expect(d, `corner ${i}: found (${found[i].x.toFixed(1)}, ${found[i].y.toFixed(1)}) vs (${truth[i].x}, ${truth[i].y})`).toBeLessThan(
      tolerance,
    );
  }
}

const DIAG = Math.hypot(800, 600);

describe("detectDocument", () => {
  it("finds the corners of a rotated bill within 3% of the true corners", () => {
    const paper = rotatedRect(400, 300, 380, 470, 9);
    const found = detectDocument(billPhoto(paper));
    expect(found).not.toBeNull();
    expect(found!.confidence).toBeGreaterThan(0.6);
    expectCornersNear(found!.quad, paper, DIAG * 0.03);
  });

  it("finds a perspective-skewed bill (photo taken at an angle)", () => {
    const paper: Quad = [
      { x: 230, y: 70 },
      { x: 560, y: 95 },
      { x: 640, y: 545 },
      { x: 150, y: 520 },
    ];
    const found = detectDocument(billPhoto(paper, 800, 600, 11));
    expect(found).not.toBeNull();
    expectCornersNear(found!.quad, paper, DIAG * 0.03);
  });

  it("handles a bill rotated close to 45 degrees", () => {
    const paper = rotatedRect(400, 300, 330, 380, -38);
    const found = detectDocument(billPhoto(paper, 800, 600, 5));
    expect(found).not.toBeNull();
    // Corners come back in TL TR BR BL order, whichever way the sheet is turned.
    const truth = orderQuad(paper);
    expectCornersNear(found!.quad, truth, DIAG * 0.03);
  });

  it("returns null when there is no document (plain table) or it is tiny", () => {
    const table = billPhoto(rotatedRect(-500, -500, 100, 100, 0)); // the sheet is off-frame
    expect(detectDocument(table)).toBeNull();
    const tiny = rotatedRect(400, 300, 120, 150, 5); // ~4% of the frame
    expect(detectDocument(billPhoto(tiny))).toBeNull();
  });

  it("maps corners back to source coordinates for large photos", () => {
    const paper = rotatedRect(400, 300, 380, 470, 6);
    const big = billPhoto(paper);
    // Simulate a 2× larger photo by nearest-neighbour upscaling.
    const W = 1600;
    const H = 1200;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = ((y >> 1) * 800 + (x >> 1)) * 4;
        const o = (y * W + x) * 4;
        data[o] = big.data[s];
        data[o + 1] = big.data[s + 1];
        data[o + 2] = big.data[s + 2];
        data[o + 3] = 255;
      }
    }
    const found = detectDocument({ width: W, height: H, data });
    expect(found).not.toBeNull();
    const truth = paper.map((p) => ({ x: p.x * 2, y: p.y * 2 })) as Quad;
    expectCornersNear(found!.quad, truth, Math.hypot(W, H) * 0.03);
  });
});

describe("orderQuad", () => {
  it("orders shuffled corners as TL, TR, BR, BL", () => {
    const pts: Point[] = [
      { x: 90, y: 110 },
      { x: 10, y: 5 },
      { x: 5, y: 100 },
      { x: 100, y: 0 },
    ];
    expect(orderQuad(pts)).toEqual([
      { x: 10, y: 5 },
      { x: 100, y: 0 },
      { x: 90, y: 110 },
      { x: 5, y: 100 },
    ]);
  });
});

describe("homography", () => {
  it("maps each source corner onto its destination corner", () => {
    const src: Quad = [
      { x: 230, y: 70 },
      { x: 560, y: 95 },
      { x: 640, y: 545 },
      { x: 150, y: 520 },
    ];
    const dst = fullQuad(420, 600);
    const h = homography(src, dst);
    expect(h).toHaveLength(9);
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(h, src[i]);
      expect(p.x).toBeCloseTo(dst[i].x, 6);
      expect(p.y).toBeCloseTo(dst[i].y, 6);
    }
  });
});

describe("warpPerspective", () => {
  const paper = rotatedRect(400, 300, 380, 470, 9);
  const photo = billPhoto(paper);

  it("sizes the output from the quad's edge lengths, or as asked", () => {
    const out = warpPerspective(photo, paper);
    expect(Math.abs(out.width - 380)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.height - 470)).toBeLessThanOrEqual(1);
    expect(out.data.length).toBe(out.width * out.height * 4);
    const fixed = warpPerspective(photo, paper, 200, 300);
    expect([fixed.width, fixed.height]).toEqual([200, 300]);
  });

  it("caps the long side at 2000 px", () => {
    const huge = fullQuad(5000, 2500);
    const out = warpPerspective({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(200) }, huge);
    expect(out.width).toBe(2000);
    expect(out.height).toBe(1000);
  });

  it("straightens the bill so only paper remains — no table at the edges", () => {
    const found = detectDocument(photo)!;
    const out = warpPerspective(photo, found.quad);
    const { width: w, height: h } = out;
    const m = 6;
    // Margins of the sheet (no print there) are bright paper on all four sides.
    expect(meanLuma(out, m, m, w - m, Math.round(h * 0.08))).toBeGreaterThan(200);
    expect(meanLuma(out, m, Math.round(h * 0.93), w - m, h - m)).toBeGreaterThan(200);
    expect(meanLuma(out, m, m, Math.round(w * 0.07), h - m)).toBeGreaterThan(200);
    expect(meanLuma(out, Math.round(w * 0.95), m, w - m, h - m)).toBeGreaterThan(200);
    // The printed interior is mostly paper.
    expect(meanLuma(out, Math.round(w * 0.1), Math.round(h * 0.1), Math.round(w * 0.9), Math.round(h * 0.9))).toBeGreaterThan(150);
  });
});

describe("enhance", () => {
  const paper = rotatedRect(400, 300, 380, 470, 9);
  const page = warpPerspective(billPhoto(paper), paper);

  it('"bw" produces pure black and white only, with the print black', () => {
    const bw = enhance(page, "bw");
    let black = 0;
    for (let i = 0; i < bw.data.length; i += 4) {
      expect([0, 255]).toContain(bw.data[i]);
      expect(bw.data[i + 1]).toBe(bw.data[i]);
      expect(bw.data[i + 2]).toBe(bw.data[i]);
      expect(bw.data[i + 3]).toBe(255);
      if (bw.data[i] === 0) black++;
    }
    const share = black / (bw.width * bw.height);
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(0.5);
  });

  it('"gray" is neutral and "color" stretches paper to near white', () => {
    const gray = enhance(page, "gray");
    for (let i = 0; i < gray.data.length; i += 4 * 97) {
      expect(gray.data[i]).toBe(gray.data[i + 1]);
      expect(gray.data[i + 1]).toBe(gray.data[i + 2]);
    }
    const color = enhance(page, "color");
    expect(meanLuma(color, 6, 6, color.width - 6, 30)).toBeGreaterThan(meanLuma(page, 6, 6, page.width - 6, 30));
    expect(meanLuma(color, 6, 6, color.width - 6, 30)).toBeGreaterThan(235);
  });
});

describe("estimateSharpness", () => {
  it("scores a sharp photo higher than a blurred one", () => {
    const photo = billPhoto(rotatedRect(400, 300, 380, 470, 9));
    const sharp = estimateSharpness(photo);
    const blurred = estimateSharpness(boxBlurRgba(photo, 3));
    expect(sharp).toBeGreaterThan(blurred * 3);
  });
});

describe("downscale", () => {
  it("limits the long side and reports the scale", () => {
    const img: Rgba = { width: 1000, height: 500, data: new Uint8ClampedArray(1000 * 500 * 4).fill(128) };
    const { img: small, scale } = downscale(img, 400);
    expect([small.width, small.height]).toEqual([400, 200]);
    expect(scale).toBeCloseTo(0.4);
    expect(small.data[0]).toBe(128);
    expect(downscale(small, 400).scale).toBe(1);
  });
});
