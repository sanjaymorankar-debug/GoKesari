/**
 * Where the browser finds the document reader's files (served by
 * src/app/api/ocr-assets/[...asset]/route.ts). The installed tesseract.js
 * version is part of the path, so a dependency update never mixes old cached
 * files with new ones.
 */
import tesseractPackage from "tesseract.js/package.json";

export const OCR_ASSET_VERSION: string = tesseractPackage.version;

export const OCR_ASSET_BASE = `/api/ocr-assets/${OCR_ASSET_VERSION}`;
