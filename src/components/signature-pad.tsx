"use client";

/**
 * Module 4 (23-Nov-2026): a signature pad for the customer's signature at the
 * door (rule deliveryProof.signatureEnabled).
 *
 * - Pointer events, so a finger, a stylus (pressure changes the line width)
 *   and a mouse all draw; `touch-action: none` stops the page scrolling while
 *   signing, and the pointer is captured so a stroke that leaves the box ends
 *   cleanly.
 * - Strokes are kept as points relative to the box (0–1), so the drawing
 *   survives a resize or rotation, and Undo / Clear simply drop strokes.
 * - Controlled: the parent holds the strokes (`value` / `onChange`) and turns
 *   them into a PNG with `signatureToPngBlob` — a fixed 600 × 240 image on a
 *   white background, whatever the screen size (the server's image rules ask
 *   for at least 100 px a side).
 * - Accessible: the drawing area is labelled and described, the buttons are
 *   real buttons, and a polite live region says whether a signature is in.
 */
import { useEffect, useId, useRef } from "react";

export interface SignaturePoint {
  /** 0–1 across the box. */
  x: number;
  /** 0–1 down the box. */
  y: number;
  /** 0–1; 0.5 for a mouse or a finger without pressure. */
  p: number;
}
export type SignatureStroke = SignaturePoint[];

export const SIGNATURE_EXPORT_WIDTH = 600;
export const SIGNATURE_EXPORT_HEIGHT = 240;
const INK = "#1f2937";

/** Line width for a point at `size` box width: thicker with more pressure. */
export function lineWidthFor(pressure: number, boxWidth: number): number {
  const base = Math.max(1.5, boxWidth / 220);
  const p = Number.isFinite(pressure) && pressure > 0 ? Math.min(pressure, 1) : 0.5;
  return base * (0.6 + p * 0.8);
}

/** True when the strokes hold something that looks like a mark (not a single tap). */
export function hasInk(strokes: readonly SignatureStroke[]): boolean {
  let points = 0;
  for (const s of strokes) points += s.length;
  return strokes.length > 0 && points >= 3;
}

/** Undo: the strokes without the last one. */
export function undoStroke(strokes: readonly SignatureStroke[]): SignatureStroke[] {
  return strokes.slice(0, -1);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Draws the strokes on a 2D context of `width` × `height` (white background when `background`). */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: readonly SignatureStroke[],
  width: number,
  height: number,
  background = false,
): void {
  ctx.clearRect(0, 0, width, height);
  if (background) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    if (stroke.length === 1) {
      const [pt] = stroke;
      ctx.beginPath();
      ctx.arc(pt.x * width, pt.y * height, lineWidthFor(pt.p, width) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1];
      const b = stroke[i];
      ctx.beginPath();
      ctx.lineWidth = lineWidthFor((a.p + b.p) / 2, width);
      ctx.moveTo(a.x * width, a.y * height);
      ctx.lineTo(b.x * width, b.y * height);
      ctx.stroke();
    }
  }
}

/** The signature as a PNG (600 × 240, white background), or null when there is nothing to export. */
export async function signatureToPngBlob(
  strokes: readonly SignatureStroke[],
  size: { width: number; height: number } = { width: SIGNATURE_EXPORT_WIDTH, height: SIGNATURE_EXPORT_HEIGHT },
): Promise<Blob | null> {
  if (!hasInk(strokes) || typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  drawStrokes(ctx, strokes, size.width, size.height, true);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

export function SignaturePad({
  value,
  onChange,
  label = "Customer signature",
  disabled = false,
  height = 180,
}: {
  value: SignatureStroke[];
  onChange: (strokes: SignatureStroke[]) => void;
  label?: string;
  disabled?: boolean;
  /** Height of the drawing box, CSS pixels (it takes the full width). */
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef<SignatureStroke | null>(null);
  // The strokes as last drawn, for the pointer handlers (which run between renders).
  const strokesRef = useRef<SignatureStroke[]>(value);
  const uid = useId();
  const labelId = `${uid}-label`;
  const descriptionId = `${uid}-help`;

  // Redraw on every change and whenever the box is resized (rotation, keyboard).
  useEffect(() => {
    strokesRef.current = value;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const w = Math.max(1, Math.round(rect.width * ratio));
      const h = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const live = drawing.current ? [...strokesRef.current, drawing.current] : strokesRef.current;
      drawStrokes(ctx, live, w, h);
    };
    paint();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [value]);

  function pointFrom(event: React.PointerEvent<HTMLCanvasElement>): SignaturePoint {
    const rect = event.currentTarget.getBoundingClientRect();
    // A mouse reports 0.5 while a button is down; a finger often 0 or 1 — treat those as "no pressure".
    const pressure = event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5;
    return {
      x: clamp01((event.clientX - rect.left) / Math.max(1, rect.width)),
      y: clamp01((event.clientY - rect.top) / Math.max(1, rect.height)),
      p: pressure,
    };
  }

  function paintSegment(stroke: SignatureStroke) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || stroke.length === 0) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const b = stroke[stroke.length - 1];
    if (stroke.length === 1) {
      ctx.beginPath();
      ctx.arc(b.x * w, b.y * h, lineWidthFor(b.p, w) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const a = stroke[stroke.length - 2];
    ctx.beginPath();
    ctx.lineWidth = lineWidthFor((a.p + b.p) / 2, w);
    ctx.moveTo(a.x * w, a.y * h);
    ctx.lineTo(b.x * w, b.y * h);
    ctx.stroke();
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drawing.current = [pointFrom(event)];
    paintSegment(drawing.current);
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    event.preventDefault();
    // Coalesced events give a smoother line on fast strokes where the browser supports them.
    const native = event.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
    const events = native.getCoalescedEvents?.() ?? [];
    if (events.length > 1) {
      const rect = event.currentTarget.getBoundingClientRect();
      for (const e of events) {
        drawing.current.push({
          x: clamp01((e.clientX - rect.left) / Math.max(1, rect.width)),
          y: clamp01((e.clientY - rect.top) / Math.max(1, rect.height)),
          p: event.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5,
        });
        paintSegment(drawing.current);
      }
      return;
    }
    drawing.current.push(pointFrom(event));
    paintSegment(drawing.current);
  }

  function finish() {
    const stroke = drawing.current;
    drawing.current = null;
    if (!stroke || stroke.length === 0) return;
    const next = [...strokesRef.current, stroke];
    strokesRef.current = next;
    onChange(next);
  }

  const signed = hasInk(value);

  return (
    <div className="space-y-2" data-testid="signature-pad">
      <p className="text-sm font-medium text-ink-700" id={labelId}>
        {label}
      </p>
      <canvas
        ref={canvasRef}
        role="img"
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        className={`block w-full rounded-lg border-2 border-dashed ${disabled ? "border-cream-200 bg-cream-100" : "border-kesari-300 bg-white"}`}
        style={{ height, touchAction: "none", cursor: disabled ? "not-allowed" : "crosshair" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      />
      <p id={descriptionId} className="text-xs text-ink-500">
        Ask the customer to sign inside the box with a finger or stylus.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-lg border border-cream-200 px-3 py-1.5 text-sm text-ink-700 disabled:opacity-50"
          onClick={() => onChange(undoStroke(value))}
          disabled={disabled || value.length === 0}
        >
          Undo
        </button>
        <button
          type="button"
          className="rounded-lg border border-cream-200 px-3 py-1.5 text-sm text-ink-700 disabled:opacity-50"
          onClick={() => onChange([])}
          disabled={disabled || value.length === 0}
        >
          Clear
        </button>
        <span className="text-xs text-ink-500" aria-live="polite">
          {signed ? "Signature drawn." : "No signature yet."}
        </span>
      </div>
    </div>
  );
}
