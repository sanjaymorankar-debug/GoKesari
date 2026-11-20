/**
 * GoKesari Health: letterhead and print settings per clinic (member NULL) or per doctor in a clinic.
 * Images are converted to JPEG for the PDF writer; they are clinic branding, not patient data.
 */
import { and, eq, isNull } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { LETTERHEAD_MODES, LOCAL_LANGUAGES, PAPER_SIZES, RX_SECTIONS } from "@/lib/health/constants";
import { requireFirmAccess } from "@/server/consult/access";
import { db } from "@/server/db";
import { consultMembers, healthLetterheads, type HealthLetterhead } from "@/server/db/schema";
import type { HealthActor } from "./access";
import { toJpeg } from "./doctors";
import { DEFAULT_LETTERHEAD, renderCalibrationPdf, type RxImages } from "./rx-pdf";

export const letterheadInput = z.object({
  memberId: z.string().uuid().nullish(),
  mode: z.enum(LETTERHEAD_MODES),
  paper: z.enum(PAPER_SIZES),
  marginTopMm: z.number().min(0).max(150),
  marginBottomMm: z.number().min(0).max(150),
  marginLeftMm: z.number().min(0).max(60),
  marginRightMm: z.number().min(0).max(60),
  headerHeightMm: z.number().min(0).max(120),
  footerHeightMm: z.number().min(0).max(80),
  fontSizePt: z.number().int().min(7).max(16),
  sections: z.partialRecord(z.enum(RX_SECTIONS), z.boolean()).default({}),
  localLanguage: z.enum(LOCAL_LANGUAGES),
  showSignature: z.boolean(),
  autoPrint: z.boolean(),
  printerName: z.string().trim().max(120).nullish(),
});

async function requireLetterheadAccess(shopId: string, memberId: string | null | undefined, actor: HealthActor) {
  if (memberId) {
    const [m] = await db.select({ shopId: consultMembers.shopId, userId: consultMembers.userId }).from(consultMembers).where(eq(consultMembers.id, memberId));
    if (!m || m.shopId !== shopId) throw notFound("Doctor");
    if (m.userId === actor.id) return;
  }
  const access = await requireFirmAccess(shopId, actor, "setup");
  if (access.role === "ONBOARDER") throw forbidden("Only the clinic can change its letterhead.");
}

/** The settings that apply: the doctor's own row, else the clinic's, else defaults. */
export async function effectiveLetterhead(shopId: string, memberId: string | null): Promise<HealthLetterhead> {
  if (memberId) {
    const [own] = await db.select().from(healthLetterheads).where(and(eq(healthLetterheads.shopId, shopId), eq(healthLetterheads.memberId, memberId)));
    if (own) return own;
  }
  const [clinic] = await db.select().from(healthLetterheads).where(and(eq(healthLetterheads.shopId, shopId), isNull(healthLetterheads.memberId)));
  if (clinic) return clinic;
  return {
    id: "default",
    shopId,
    memberId: null,
    ...DEFAULT_LETTERHEAD,
    headerImage: null,
    headerType: null,
    footerImage: null,
    footerType: null,
    backgroundImage: null,
    backgroundType: null,
    localLanguage: "NONE",
    autoPrint: false,
    printerName: null,
    updatedBy: null,
    updatedAt: new Date(0),
  };
}

export async function saveLetterhead(shopId: string, raw: unknown, actor: HealthActor): Promise<HealthLetterhead> {
  const input = letterheadInput.parse(raw);
  await requireLetterheadAccess(shopId, input.memberId, actor);
  const values = {
    shopId,
    memberId: input.memberId ?? null,
    mode: input.mode,
    paper: input.paper,
    marginTopMm: input.marginTopMm,
    marginBottomMm: input.marginBottomMm,
    marginLeftMm: input.marginLeftMm,
    marginRightMm: input.marginRightMm,
    headerHeightMm: input.headerHeightMm,
    footerHeightMm: input.footerHeightMm,
    fontSizePt: input.fontSizePt,
    sections: input.sections,
    localLanguage: input.localLanguage,
    showSignature: input.showSignature,
    autoPrint: input.autoPrint,
    printerName: input.printerName ?? null,
    updatedBy: actor.id,
    updatedAt: new Date(),
  };
  const [existing] = await db
    .select({ id: healthLetterheads.id })
    .from(healthLetterheads)
    .where(and(eq(healthLetterheads.shopId, shopId), input.memberId ? eq(healthLetterheads.memberId, input.memberId) : isNull(healthLetterheads.memberId)));
  const [row] = existing ? await db.update(healthLetterheads).set(values).where(eq(healthLetterheads.id, existing.id)).returning() : await db.insert(healthLetterheads).values(values).returning();
  return row;
}

/** Header / footer / full-page background image. Pass empty bytes to remove it. */
export async function uploadLetterheadImage(shopId: string, memberId: string | null, which: "header" | "footer" | "background", bytes: Buffer, actor: HealthActor): Promise<void> {
  await requireLetterheadAccess(shopId, memberId, actor);
  let row = await effectiveLetterhead(shopId, memberId);
  if (row.id === "default" || (row.memberId ?? null) !== (memberId ?? null)) {
    row = await saveLetterhead(shopId, { ...DEFAULT_LETTERHEAD, sections: {}, memberId, mode: "DIGITAL", localLanguage: "NONE", autoPrint: false }, actor);
  }
  if (bytes.length > 8_000_000) throw validationFailed("Upload an image under 8 MB.");
  let jpeg: Buffer | null = null;
  if (bytes.length) {
    // A PDF page cannot be read here: ask for an image export of it.
    if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") throw validationFailed("Export the letterhead page as a PNG or JPEG image and upload that.");
    jpeg = await toJpeg(bytes, 2480);
  }
  const set = which === "header" ? { headerImage: jpeg, headerType: jpeg ? "image/jpeg" : null } : which === "footer" ? { footerImage: jpeg, footerType: jpeg ? "image/jpeg" : null } : { backgroundImage: jpeg, backgroundType: jpeg ? "image/jpeg" : null };
  await db
    .update(healthLetterheads)
    .set({ ...set, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(healthLetterheads.id, row.id));
}

async function dims(jpeg: Buffer | null): Promise<{ jpeg: Buffer; width: number; height: number } | null> {
  if (!jpeg) return null;
  const meta = await sharp(jpeg).metadata();
  return meta.width && meta.height ? { jpeg, width: meta.width, height: meta.height } : null;
}

export async function letterheadImages(lh: Pick<HealthLetterhead, "headerImage" | "footerImage" | "backgroundImage">): Promise<Pick<RxImages, "header" | "footer" | "background">> {
  return { header: await dims(lh.headerImage), footer: await dims(lh.footerImage), background: await dims(lh.backgroundImage) };
}

export async function imageWithSize(jpeg: Buffer | null): Promise<{ jpeg: Buffer; width: number; height: number } | null> {
  return dims(jpeg);
}

export async function calibrationPdf(shopId: string, memberId: string | null, actor: HealthActor): Promise<Buffer> {
  await requireLetterheadAccess(shopId, memberId, actor);
  return renderCalibrationPdf(await effectiveLetterhead(shopId, memberId));
}

export type LetterheadView = Omit<HealthLetterhead, "headerImage" | "footerImage" | "backgroundImage"> & { hasHeader: boolean; hasFooter: boolean; hasBackground: boolean };

export function letterheadView(lh: HealthLetterhead): LetterheadView {
  const { headerImage, footerImage, backgroundImage, ...rest } = lh;
  return { ...rest, hasHeader: Boolean(headerImage), hasFooter: Boolean(footerImage), hasBackground: Boolean(backgroundImage) };
}
