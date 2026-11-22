/**
 * Shapes shared by the photo shopping list pages and APIs (docs/smart-shopping-2026-11). Client-safe.
 */
import type { BaseUnit } from "./qty-words";

export const LIST_LANGUAGES = ["mr", "hi", "en", "gu", "kn", "ta", "te", "bn", "ur"] as const;
export type ListLanguage = (typeof LIST_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<string, string> = {
  mr: "Marathi",
  hi: "Hindi",
  en: "English",
  gu: "Gujarati",
  kn: "Kannada",
  ta: "Tamil",
  te: "Telugu",
  bn: "Bengali",
  ur: "Urdu",
};

export const UNREADABLE_MESSAGES: Record<string, string> = {
  BLURRY: "The photo is too blurry to read. Hold the phone steady and take it again.",
  DARK: "The photo is too dark to read. Take it again in better light.",
  NOT_A_LIST: "This doesn't look like a shopping list. Take a photo of the list itself.",
  EMPTY: "No items could be read from this photo. Take it again closer to the list, or add items by hand.",
};

export interface MatchCandidate {
  productId: string;
  name: string;
  brand: string | null;
  unit: string;
  unitSizeMilli: number;
  imageUrl: string | null;
  /** 0–100 */
  score: number;
}

/** One line read from a list photo, before the customer saves it. */
export interface ScannedLine {
  raw: string;
  language: string;
  nameEn: string;
  nameLocal: string;
  brand: string | null;
  quantityAmount: number;
  quantityUnit: BaseUnit;
  quantityDisplay: string;
  /** AI: how sure it read the line (0–100). */
  readConfidence: number;
  /** Best match (or null) and the alternatives. */
  productId: string | null;
  matchConfidence: number;
  candidates: MatchCandidate[];
}

export const QUANTITY_UNITS: BaseUnit[] = ["g", "ml", "piece", "pack", "box", "m"];
export const QUANTITY_UNIT_LABELS: Record<BaseUnit, string> = {
  g: "g",
  ml: "ml",
  piece: "piece",
  pack: "packet",
  box: "box",
  m: "metre",
};

export type CompareSort = "TOTAL" | "NEAREST" | "MOST_ITEMS";
