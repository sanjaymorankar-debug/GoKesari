/**
 * Finding QR codes in a supplier invoice's photo, scan or PDF (Module 2,
 * purchase entry): the e-invoice signed QR (see src/lib/einvoice/parse.ts),
 * a UPI QR, anything else printed as a QR. Returns each code's text; the
 * caller decides what it is.
 *
 * jsQR finds one code per pass and is sensitive to scale and contrast, so a
 * photo gets several passes: as is (capped in size), downscaled, grayscale
 * with stretched contrast, and each quadrant (e-invoice QRs sit top-right,
 * so that quadrant goes first). Results are deduplicated in the order found.
 *
 * PDFs: the embedded images of the first 3 pages (via unpdf) go through the
 * same passes; images under 100 px a side are skipped. Nothing here throws —
 * an unreadable file gives [] — and a time budget bounds the work.
 */
import jsQR from "jsqr";
import sharp from "sharp";

/** Longest side of the "as is" pass; larger photos are shrunk to this. */
const FULL_MAX_SIDE = 2400;
const SMALL_MAX_SIDE = 1000;
const GRAY_MAX_SIDE = 1600;
const MIN_IMAGE_SIDE = 100;
const PDF_MAX_PAGES = 3;
const PDF_MAX_IMAGES_PER_PAGE = 12;
const TIME_BUDGET_MS = 12_000;

interface Raw {
  data: Buffer;
  width: number;
  height: number;
}

interface RawInput {
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

type Source = { image: Buffer; raw?: RawInput };

const pipeline = (src: Source) => sharp(src.image, { raw: src.raw, limitInputPixels: 100_000_000, failOn: "none" });

type Pipeline = ReturnType<typeof sharp>;

async function rgba(img: Pipeline): Promise<Raw> {
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels === 4) return { data, width, height };
  // Grey (1), grey + alpha (2) or RGB (3) → RGBA, which is all jsQR reads.
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0, o = 0; i < data.length; i += channels, o += 4) {
    const grey = channels < 3;
    out[o] = data[i];
    out[o + 1] = grey ? data[i] : data[i + 1];
    out[o + 2] = grey ? data[i] : data[i + 2];
    out[o + 3] = 255;
  }
  return { data: out, width, height };
}

function decodeRaw(raw: Raw): string | null {
  if (raw.width < 21 || raw.height < 21) return null;
  const pixels = new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.width * raw.height * 4);
  const code = jsQR(pixels, raw.width, raw.height, { inversionAttempts: "attemptBoth" });
  return code?.data ? code.data : null;
}

const fit = (side: number) => ({ width: side, height: side, fit: "inside" as const, withoutEnlargement: true });

async function scan(src: Source, found: Set<string>, deadline: number): Promise<void> {
  const meta = src.raw ?? (await pipeline(src).metadata());
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) return;

  const tryOne = async (make: () => Pipeline) => {
    if (Date.now() > deadline) return;
    try {
      const text = decodeRaw(await rgba(make()));
      if (text) found.add(text);
    } catch {
      // One failed pass does not stop the others.
    }
  };

  const before = found.size;
  // .rotate() applies the EXIF orientation of phone photos.
  await tryOne(() => pipeline(src).rotate().resize(fit(FULL_MAX_SIDE)));
  if (Math.max(width, height) > SMALL_MAX_SIDE * 1.3) await tryOne(() => pipeline(src).rotate().resize(fit(SMALL_MAX_SIDE)));
  if (found.size === before) {
    await tryOne(() => pipeline(src).rotate().resize(fit(GRAY_MAX_SIDE)).grayscale().normalise().sharpen());
  }

  // Quadrants, top-right first, from an upright copy (EXIF applied) so the
  // crop boxes match what a person sees. Each box is 60% of a side, so a
  // code sitting on a middle line is still whole in one of them.
  let upright: Buffer;
  let uw: number;
  let uh: number;
  try {
    const { data, info } = await pipeline(src).rotate().resize(fit(FULL_MAX_SIDE * 1.5)).png({ compressionLevel: 1 }).toBuffer({ resolveWithObject: true });
    [upright, uw, uh] = [data, info.width, info.height];
  } catch {
    return;
  }
  const qw = Math.min(uw, Math.round(uw * 0.6));
  const qh = Math.min(uh, Math.round(uh * 0.6));
  const boxes = [
    { left: uw - qw, top: 0 },
    { left: 0, top: 0 },
    { left: uw - qw, top: uh - qh },
    { left: 0, top: uh - qh },
  ];
  for (const box of boxes) {
    await tryOne(() =>
      sharp(upright)
        .extract({ left: box.left, top: box.top, width: qw, height: qh })
        .resize(fit(FULL_MAX_SIDE))
        .grayscale()
        .normalise(),
    );
  }
}

/** Every QR code's text found in a photo or scan (JPEG, PNG, WebP, …); [] when none or unreadable. */
export async function findQrCodes(image: Buffer): Promise<string[]> {
  const found = new Set<string>();
  try {
    await scan({ image }, found, Date.now() + TIME_BUDGET_MS);
  } catch {
    // Not an image sharp can read.
  }
  return [...found];
}

/** Every QR code's text in the images of a PDF's first 3 pages; [] on any failure. */
export async function findQrCodesInPdf(pdf: Buffer): Promise<string[]> {
  const found = new Set<string>();
  const deadline = Date.now() + TIME_BUDGET_MS;
  try {
    const { extractImages, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    const pages = Math.min(doc.numPages, PDF_MAX_PAGES);
    for (let page = 1; page <= pages && Date.now() < deadline; page++) {
      let images: Awaited<ReturnType<typeof extractImages>>;
      try {
        images = await extractImages(doc, page);
      } catch {
        continue;
      }
      for (const img of images.slice(0, PDF_MAX_IMAGES_PER_PAGE)) {
        if (img.width < MIN_IMAGE_SIDE || img.height < MIN_IMAGE_SIDE || Date.now() > deadline) continue;
        const image = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
        await scan({ image, raw: { width: img.width, height: img.height, channels: img.channels } }, found, deadline);
      }
    }
    await doc.cleanup().catch(() => undefined);
  } catch {
    // Not a PDF unpdf can open.
  }
  return [...found];
}
