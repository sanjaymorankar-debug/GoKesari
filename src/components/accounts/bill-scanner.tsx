"use client";

/**
 * "Scan a paper bill": the shop owner photographs a supplier's paper bill,
 * one or more pages, and gets back clean, straightened, small JPEGs ready to
 * upload on a slow network.
 *
 * Each photo is decoded (orientation fixed), the sheet is found and cut out
 * of the table (perspective corrected), cleaned up (Colour by default; Gray
 * or B&W on request) and compressed — all in the browser, with pauses between
 * steps so the screen keeps responding. The owner can drag the four corners
 * if the crop is off, retake a blurred page, and reorder or remove pages.
 *
 * Taking the photo: "Take photo" is a file input with capture="environment",
 * which opens the phone's own camera app — including inside the Android/iPhone
 * app, which has no camera permission of its own (see
 * document-upload-panel.tsx). "Choose from gallery / files" picks existing
 * photos, several at once.
 *
 * Memory: a decoded 12 MP photo is tens of megabytes, so only the page being
 * worked on is kept decoded; every other page is kept as its original file
 * plus its finished JPEG, and is decoded again only if its corners or colour
 * mode change.
 *
 * Labels default to English; callers pass Hindi/Marathi through `labels`.
 */
import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";

import { Alert, Button } from "@/components/ui";
import { encodeJpeg, loadImageFile, rgbaToCanvas, rgbaToDataUrl, yieldToBrowser } from "@/lib/scan/browser";
import {
  BLUR_THRESHOLD,
  SHARPNESS_SIZE,
  detectDocument,
  downscale,
  enhance,
  estimateSharpness,
  fullQuad,
  warpPerspective,
  type EnhanceMode,
  type Point,
  type Quad,
  type Rgba,
} from "@/lib/scan/document-scan";

export interface ScannedPage {
  /** The finished page as a JPEG (aimed at under ~400 KB). */
  blob: Blob;
  width: number;
  height: number;
  /** Variance of the Laplacian at SHARPNESS_SIZE; below BLUR_THRESHOLD the page probably reads poorly. */
  sharpness: number;
  /** True when the sheet's edges were found automatically (the owner may have fine-tuned the corners since). */
  autoCropped: boolean;
}

export type BillScannerLabelKey =
  | "take"
  | "addPage"
  | "retake"
  | "done"
  | "adjust"
  | "modeColor"
  | "modeGray"
  | "modeBw"
  | "blurred"
  | "noEdges"
  | "pageOf"
  | "remove"
  | "moveUp"
  | "moveDown"
  | "fromGallery"
  // Beyond the core set, for the adjust view, progress and errors.
  | "cancel"
  | "apply"
  | "resetCorners"
  | "wholePhoto"
  | "adjustHint"
  | "processing"
  | "loadError"
  | "intro"
  | "maxPages"
  | "cornerTL"
  | "cornerTR"
  | "cornerBR"
  | "cornerBL"
  | "pageThumb";

const DEFAULT_LABELS: Record<BillScannerLabelKey, string> = {
  take: "Take photo",
  addPage: "Add page",
  retake: "Retake",
  done: "Done",
  adjust: "Adjust corners",
  modeColor: "Colour",
  modeGray: "Gray",
  modeBw: "B&W",
  blurred: "Photo looks blurred — retake?",
  noEdges: "Edges not found — the whole photo will be used; adjust corners if needed",
  pageOf: "Page {n} of {total}",
  remove: "Remove",
  moveUp: "Move up",
  moveDown: "Move down",
  fromGallery: "Choose from gallery / files",
  cancel: "Cancel",
  apply: "Use these corners",
  resetCorners: "Reset",
  wholePhoto: "Whole photo",
  adjustHint: "Drag the four circles onto the corners of the bill.",
  processing: "Straightening the photo…",
  loadError: "This photo could not be opened. Please take it again or choose another photo.",
  intro: "Place the bill flat on a darker surface, in good light, with all four corners showing.",
  maxPages: "Maximum {max} pages.",
  cornerTL: "Top-left corner",
  cornerTR: "Top-right corner",
  cornerBR: "Bottom-right corner",
  cornerBL: "Bottom-left corner",
  pageThumb: "Page {n}",
};

/** Photos are decoded at this long side: sharp enough to read, light enough for low-end phones. */
const LOAD_SIDE = 2400;
/** Long side of the image shown in the corner-adjust view. */
const ADJUST_DISPLAY_SIDE = 1000;
/** Upload JPEG: starting quality and long side (see encodeJpeg). */
const JPEG_QUALITY = 0.82;
const JPEG_SIDE = 1800;

interface PageState {
  id: number;
  file: File;
  srcWidth: number;
  srcHeight: number;
  /** The crop, in the decoded photo's pixel coordinates. */
  quad: Quad;
  /** What detection found (null: nothing found), for "Reset" in the adjust view. */
  detectedQuad: Quad | null;
  mode: EnhanceMode;
  blob: Blob;
  width: number;
  height: number;
  sharpness: number;
  previewUrl: string;
  thumbUrl: string;
}

/** The one page kept decoded (see "Memory" above). */
interface WorkCache {
  id: number;
  source: Rgba;
  /** Straightened, before enhancement, for the current quad. */
  warped: Rgba | null;
}

interface AdjustState {
  pageId: number;
  display: Rgba;
  srcWidth: number;
  srcHeight: number;
  quad: Quad;
  detectedQuad: Quad | null;
}

function fill(template: string, values: Record<string, number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

async function renderPage(source: Rgba, quad: Quad, mode: EnhanceMode, warpedAlready?: Rgba | null) {
  const warped = warpedAlready ?? warpPerspective(source, quad);
  await yieldToBrowser();
  const enhanced = enhance(warped, mode);
  await yieldToBrowser();
  const sharpness = Math.round(estimateSharpness(downscale(warped, SHARPNESS_SIZE).img));
  const encoded = await encodeJpeg(enhanced, JPEG_QUALITY, JPEG_SIDE);
  const thumbUrl = rgbaToDataUrl(enhanced, 160, 0.6);
  return { warped, sharpness, thumbUrl, ...encoded };
}

export function BillScanner({
  onDone,
  onCancel,
  maxPages = 10,
  busy = false,
  labels: labelOverrides,
}: {
  onDone: (pages: ScannedPage[]) => void;
  onCancel?: () => void;
  maxPages?: number;
  busy?: boolean;
  labels?: Partial<Record<BillScannerLabelKey, string>>;
}): JSX.Element {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const [pages, setPages] = useState<PageState[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adjust, setAdjust] = useState<AdjustState | null>(null);

  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const retakeTarget = useRef<number | null>(null);
  const nextId = useRef(1);
  const cache = useRef<WorkCache | null>(null);
  const running = useRef(false);
  const liveUrls = useRef(new Set<string>());

  // Free every page preview when the scanner goes away.
  useEffect(() => {
    const urls = liveUrls.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
      cache.current = null;
    };
  }, []);

  const selectedIndex = pages.findIndex((p) => p.id === selectedId);
  const selected = selectedIndex >= 0 ? pages[selectedIndex] : (pages[pages.length - 1] ?? null);
  const shownIndex = selected ? pages.indexOf(selected) : -1;
  const disabled = working || busy;
  const full = pages.length >= maxPages;

  function previewUrlFor(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    liveUrls.current.add(url);
    return url;
  }

  function releaseUrl(url: string) {
    URL.revokeObjectURL(url);
    liveUrls.current.delete(url);
  }

  /** Runs one heavy job at a time, with the progress line shown and errors reported. */
  async function job(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setWorking(true);
    setError(null);
    await yieldToBrowser();
    try {
      await work();
    } catch {
      setError(labels.loadError);
    } finally {
      running.current = false;
      setWorking(false);
    }
  }

  async function sourceFor(page: PageState): Promise<Rgba> {
    if (cache.current?.id === page.id) return cache.current.source;
    cache.current = null; // drop the previous page's pixels before decoding another
    const source = await loadImageFile(page.file, LOAD_SIDE);
    cache.current = { id: page.id, source, warped: null };
    return source;
  }

  async function addFiles(files: File[], replaceId: number | null) {
    await job(async () => {
      let room = replaceId !== null ? 1 : Math.max(0, maxPages - pages.length);
      for (const file of files) {
        if (room <= 0) break;
        cache.current = null;
        const source = await loadImageFile(file, LOAD_SIDE);
        await yieldToBrowser();
        const found = detectDocument(source);
        const quad = found?.quad ?? fullQuad(source.width, source.height);
        await yieldToBrowser();
        const result = await renderPage(source, quad, "color");
        const id = nextId.current++;
        cache.current = { id, source, warped: result.warped };
        const page: PageState = {
          id,
          file,
          srcWidth: source.width,
          srcHeight: source.height,
          quad,
          detectedQuad: found?.quad ?? null,
          mode: "color",
          blob: result.blob,
          width: result.width,
          height: result.height,
          sharpness: result.sharpness,
          previewUrl: previewUrlFor(result.blob),
          thumbUrl: result.thumbUrl,
        };
        const replaced = replaceId !== null ? pages.find((p) => p.id === replaceId) : undefined;
        if (replaced) releaseUrl(replaced.previewUrl);
        setPages((prev) => (replaced && prev.some((p) => p.id === replaced.id) ? prev.map((p) => (p.id === replaced.id ? page : p)) : [...prev, page]));
        setSelectedId(id);
        room--;
        await yieldToBrowser();
      }
    });
  }

  async function rerender(page: PageState, changes: { quad?: Quad; mode?: EnhanceMode }) {
    await job(async () => {
      const quad = changes.quad ?? page.quad;
      const mode = changes.mode ?? page.mode;
      const source = await sourceFor(page);
      const reuse = !changes.quad && cache.current?.id === page.id ? cache.current.warped : null;
      const result = await renderPage(source, quad, mode, reuse);
      if (cache.current?.id === page.id) cache.current.warped = result.warped;
      const updated: PageState = {
        ...page,
        quad,
        mode,
        blob: result.blob,
        width: result.width,
        height: result.height,
        sharpness: result.sharpness,
        previewUrl: previewUrlFor(result.blob),
        thumbUrl: result.thumbUrl,
      };
      setPages((prev) => prev.map((p) => (p.id === page.id ? updated : p)));
      releaseUrl(page.previewUrl);
    });
  }

  async function openAdjust(page: PageState) {
    await job(async () => {
      const source = await sourceFor(page);
      const display = downscale(source, ADJUST_DISPLAY_SIDE).img;
      setAdjust({
        pageId: page.id,
        display,
        srcWidth: page.srcWidth,
        srcHeight: page.srcHeight,
        quad: page.quad.map((p) => ({ ...p })) as Quad,
        detectedQuad: page.detectedQuad,
      });
    });
  }

  function removePage(page: PageState) {
    releaseUrl(page.previewUrl);
    if (cache.current?.id === page.id) cache.current = null;
    const index = pages.indexOf(page);
    const rest = pages.filter((p) => p.id !== page.id);
    setPages(rest);
    setSelectedId(rest[Math.min(index, rest.length - 1)]?.id ?? null);
  }

  function movePage(page: PageState, delta: -1 | 1) {
    const from = pages.indexOf(page);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= pages.length) return;
    const next = [...pages];
    [next[from], next[to]] = [next[to], next[from]];
    setPages(next);
  }

  function capture(replaceId: number | null) {
    retakeTarget.current = replaceId;
    cameraInput.current?.click();
  }

  function finish() {
    onDone(
      pages.map((p) => ({
        blob: p.blob,
        width: p.width,
        height: p.height,
        sharpness: p.sharpness,
        autoCropped: p.detectedQuad !== null,
      })),
    );
  }

  const modes: { mode: EnhanceMode; label: string }[] = [
    { mode: "color", label: labels.modeColor },
    { mode: "gray", label: labels.modeGray },
    { mode: "bw", label: labels.modeBw },
  ];

  const inputs = (
    <>
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        data-testid="bill-scan-camera"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          const replaceId = retakeTarget.current;
          retakeTarget.current = null;
          if (file) void addFiles([file], replaceId);
        }}
      />
      <input
        ref={galleryInput}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden
        data-testid="bill-scan-gallery"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void addFiles(files, null);
        }}
      />
    </>
  );

  if (adjust) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3" data-testid="bill-scanner">
        {inputs}
        <CornerAdjuster
          state={adjust}
          labels={labels}
          disabled={disabled}
          onCancel={() => setAdjust(null)}
          onApply={(quad) => {
            const page = pages.find((p) => p.id === adjust.pageId);
            setAdjust(null);
            if (page) void rerender(page, { quad });
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="bill-scanner">
      {inputs}

      {working ? (
        <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-ink-700" data-testid="bill-scan-working">
          <span aria-hidden className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-kesari-600 border-t-transparent" />
          {labels.processing}
        </p>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {!selected ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink-600">{labels.intro}</p>
          <Button size="lg" className="w-full" disabled={disabled} onClick={() => capture(null)} data-testid="bill-scan-take">
            {labels.take}
          </Button>
          <Button variant="secondary" className="w-full" disabled={disabled} onClick={() => galleryInput.current?.click()} data-testid="bill-scan-from-gallery">
            {labels.fromGallery}
          </Button>
          {onCancel ? (
            <Button variant="ghost" className="w-full" disabled={busy} onClick={onCancel}>
              {labels.cancel}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="bill-scan-page">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink-900" data-testid="bill-scan-page-of">
                {fill(labels.pageOf, { n: shownIndex + 1, total: pages.length })}
              </p>
              <div role="group" aria-label={`${labels.modeColor} / ${labels.modeGray} / ${labels.modeBw}`} className="inline-flex overflow-hidden rounded-lg border border-cream-200">
                {modes.map(({ mode, label }) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={selected.mode === mode}
                    disabled={disabled}
                    onClick={() => {
                      if (selected.mode !== mode) void rerender(selected, { mode });
                    }}
                    className={clsx(
                      "min-h-10 px-3 text-sm font-medium disabled:cursor-not-allowed",
                      selected.mode === mode ? "bg-kesari-600 text-white" : "bg-white text-ink-700 hover:bg-cream-100",
                    )}
                    data-testid={`bill-scan-mode-${mode}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-cream-200 bg-cream-100">
              {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: URL of the scanned page */}
              <img
                src={selected.previewUrl}
                alt={fill(labels.pageOf, { n: shownIndex + 1, total: pages.length })}
                className="max-h-[42vh] min-h-0 w-auto max-w-full object-contain"
                data-testid="bill-scan-preview"
              />
            </div>

            {selected.sharpness < BLUR_THRESHOLD ? (
              <div data-testid="bill-scan-blurred">
                <Alert tone="warning">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span>{labels.blurred}</span>
                    <Button size="sm" variant="secondary" disabled={disabled} onClick={() => capture(selected.id)}>
                      {labels.retake}
                    </Button>
                  </span>
                </Alert>
              </div>
            ) : null}
            {!selected.detectedQuad ? (
              <div data-testid="bill-scan-no-edges">
                <Alert tone="info">{labels.noEdges}</Alert>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void openAdjust(selected)} data-testid="bill-scan-adjust">
                {labels.adjust}
              </Button>
              <Button size="sm" variant="secondary" disabled={disabled} onClick={() => capture(selected.id)} data-testid="bill-scan-retake">
                {labels.retake}
              </Button>
              <Button size="sm" variant="ghost" disabled={disabled || shownIndex <= 0} onClick={() => movePage(selected, -1)}>
                <span aria-hidden>↑</span> {labels.moveUp}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || shownIndex >= pages.length - 1}
                onClick={() => movePage(selected, 1)}
              >
                <span aria-hidden>↓</span> {labels.moveDown}
              </Button>
              <Button size="sm" variant="ghost" className="text-red-700" disabled={disabled} onClick={() => removePage(selected)} data-testid="bill-scan-remove">
                {labels.remove}
              </Button>
            </div>

            {pages.length > 1 ? (
              <ol className="flex shrink-0 gap-2 overflow-x-auto pb-1" data-testid="bill-scan-thumbs">
                {pages.map((page, index) => {
                  const name = fill(labels.pageThumb, { n: index + 1 });
                  return (
                    <li key={page.id} className="shrink-0">
                      <button
                        type="button"
                        onClick={() => setSelectedId(page.id)}
                        aria-current={page.id === selected.id ? "true" : undefined}
                        aria-label={name}
                        className={clsx(
                          "relative block h-16 w-12 overflow-hidden rounded-md border-2 bg-cream-100",
                          page.id === selected.id ? "border-kesari-600" : "border-cream-200",
                        )}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- a local data: URL thumbnail */}
                        <img src={page.thumbUrl} alt="" className="h-full w-full object-cover" />
                        <span className="absolute bottom-0 left-0 rounded-tr bg-ink-900/75 px-1 text-xs font-semibold text-white">{index + 1}</span>
                        {page.sharpness < BLUR_THRESHOLD ? (
                          <span className="absolute right-0 top-0 rounded-bl bg-amber-500 px-1 text-xs font-bold text-white" aria-hidden>
                            !
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap gap-2 border-t border-cream-200 pt-3">
            {!full ? (
              <>
                <Button disabled={disabled} onClick={() => capture(null)} data-testid="bill-scan-add-page">
                  {labels.addPage}
                </Button>
                <Button variant="secondary" disabled={disabled} onClick={() => galleryInput.current?.click()} data-testid="bill-scan-from-gallery">
                  {labels.fromGallery}
                </Button>
              </>
            ) : (
              <p className="self-center text-xs text-ink-500">{fill(labels.maxPages, { max: maxPages })}</p>
            )}
            <span className="flex-1" />
            {onCancel ? (
              <Button variant="ghost" disabled={busy} onClick={onCancel}>
                {labels.cancel}
              </Button>
            ) : null}
            <Button disabled={disabled || pages.length === 0} onClick={finish} data-testid="bill-scan-done">
              {labels.done} ({pages.length})
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------- corner adjust */

const CORNER_KEYS = ["cornerTL", "cornerTR", "cornerBR", "cornerBL"] as const;
const MAGNIFIER_PX = 112;
const MAGNIFIER_ZOOM = 3;

function CornerAdjuster({
  state,
  labels,
  disabled,
  onApply,
  onCancel,
}: {
  state: AdjustState;
  labels: Record<BillScannerLabelKey, string>;
  disabled: boolean;
  onApply: (quad: Quad) => void;
  onCancel: () => void;
}) {
  const { display, srcWidth, srcHeight, detectedQuad } = state;
  const [quad, setQuad] = useState<Quad>(state.quad);
  const [dragging, setDragging] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const magnifier = useRef<HTMLCanvasElement>(null);

  // Paint the photo once.
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    target.width = display.width;
    target.height = display.height;
    target.getContext("2d")?.drawImage(rgbaToCanvas(display), 0, 0);
  }, [display]);

  // While a corner is dragged, show the area under the finger enlarged.
  useEffect(() => {
    if (dragging === null) return;
    const lens = magnifier.current;
    const photo = canvas.current;
    const ctx = lens?.getContext("2d");
    if (!lens || !photo || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    lens.width = MAGNIFIER_PX * ratio;
    lens.height = MAGNIFIER_PX * ratio;
    const k = photo.width / srcWidth;
    const cx = quad[dragging].x * k;
    const cy = quad[dragging].y * k;
    const shownPerCssPx = photo.width / Math.max(1, photo.getBoundingClientRect().width);
    const half = (MAGNIFIER_PX / MAGNIFIER_ZOOM / 2) * shownPerCssPx;
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, lens.width, lens.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(photo, cx - half, cy - half, half * 2, half * 2, 0, 0, lens.width, lens.height);
    ctx.strokeStyle = "#c9450c";
    ctx.lineWidth = 2 * ratio;
    ctx.beginPath();
    ctx.moveTo(lens.width / 2, 0);
    ctx.lineTo(lens.width / 2, lens.height);
    ctx.moveTo(0, lens.height / 2);
    ctx.lineTo(lens.width, lens.height / 2);
    ctx.stroke();
  }, [dragging, quad, srcWidth]);

  function moveCorner(index: number, point: Point) {
    setQuad((prev) => {
      const next = prev.map((p) => ({ ...p })) as Quad;
      next[index] = { x: Math.min(srcWidth, Math.max(0, point.x)), y: Math.min(srcHeight, Math.max(0, point.y)) };
      return next;
    });
  }

  function pointAt(event: ReactPointerEvent): Point | null {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return { x: ((event.clientX - rect.left) / rect.width) * srcWidth, y: ((event.clientY - rect.top) / rect.height) * srcHeight };
  }

  function onKey(index: number, event: ReactKeyboardEvent) {
    const step = (event.shiftKey ? 0.025 : 0.005) * Math.max(srcWidth, srcHeight);
    const delta: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const d = delta[event.key];
    if (!d) return;
    event.preventDefault();
    moveCorner(index, { x: quad[index].x + d.x, y: quad[index].y + d.y });
  }

  const ratio = srcWidth / srcHeight;
  const points = quad.map((p) => `${p.x},${p.y}`).join(" ");
  // Magnifier sits in the top corner away from the finger.
  const lensOnLeft = dragging !== null && quad[dragging].x > srcWidth / 2;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="bill-scan-adjust-view">
      <p className="text-sm text-ink-700">{labels.adjustHint}</p>
      <div className="flex min-h-0 flex-1 items-start justify-center">
        <div
          ref={box}
          className="relative touch-none select-none overflow-visible"
          style={{ aspectRatio: `${srcWidth} / ${srcHeight}`, width: `min(100%, calc(52vh * ${ratio}))` }}
        >
          <canvas ref={canvas} className="absolute inset-0 h-full w-full rounded-lg bg-ink-900" aria-hidden />
          <svg viewBox={`0 0 ${srcWidth} ${srcHeight}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            <polygon points={points} fill="rgba(201,69,12,0.15)" stroke="#c9450c" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </svg>
          {quad.map((p, i) => (
            <button
              key={CORNER_KEYS[i]}
              type="button"
              aria-label={labels[CORNER_KEYS[i]]}
              className={clsx(
                "absolute h-11 w-11 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-white bg-kesari-600/40 shadow-md",
                "focus:outline-none focus-visible:ring-4 focus-visible:ring-kesari-300",
                dragging === i && "bg-kesari-600/20",
              )}
              style={{ left: `${(p.x / srcWidth) * 100}%`, top: `${(p.y / srcHeight) * 100}%` }}
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                setDragging(i);
              }}
              onPointerMove={(e) => {
                if (dragging !== i) return;
                const point = pointAt(e);
                if (point) moveCorner(i, point);
              }}
              onPointerUp={() => setDragging(null)}
              onPointerCancel={() => setDragging(null)}
              onKeyDown={(e) => onKey(i, e)}
              data-testid={`bill-scan-corner-${i}`}
            >
              <span aria-hidden className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
            </button>
          ))}
          {dragging !== null ? (
            <canvas
              ref={magnifier}
              aria-hidden
              className={clsx("pointer-events-none absolute top-2 rounded-full border-2 border-white shadow-lg", lensOnLeft ? "left-2" : "right-2")}
              style={{ width: MAGNIFIER_PX, height: MAGNIFIER_PX }}
            />
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 border-t border-cream-200 pt-3">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => setQuad((detectedQuad ?? fullQuad(srcWidth, srcHeight)).map((p) => ({ ...p })) as Quad)}
        >
          {labels.resetCorners}
        </Button>
        {detectedQuad ? (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setQuad(fullQuad(srcWidth, srcHeight))}>
            {labels.wholePhoto}
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={onCancel}>
          {labels.cancel}
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => onApply(quad)} data-testid="bill-scan-apply">
          {labels.apply}
        </Button>
      </div>
    </div>
  );
}
