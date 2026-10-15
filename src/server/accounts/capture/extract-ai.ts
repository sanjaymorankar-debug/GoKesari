/**
 * Reading a supplier bill with Claude (docs/inventory-accounting-2026-10, Parts 4–5):
 * printed and common handwritten bills in English, Hindi and Marathi, photos
 * and PDFs, several pages at once. Returns every field with the model's own
 * confidence, so the review screen can highlight what to check.
 *
 * On only when INVOICE_EXTRACTION_PROVIDER is "claude" (the default when
 * ANTHROPIC_API_KEY is set): bills are business documents of the shop, sent to
 * Anthropic for reading only. Without it the local engines are used
 * (e-invoice JSON / QR, Excel, PDF text, tesseract OCR).
 */
import { z } from "zod";

export function aiExtractionEnabled(): boolean {
  const provider = (process.env.INVOICE_EXTRACTION_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "claude" : "local")).trim().toLowerCase();
  return provider === "claude" && Boolean(process.env.ANTHROPIC_API_KEY);
}

const conf = z.number().min(0).max(100);
const field = <T extends z.ZodTypeAny>(t: T) => z.object({ value: t.nullable(), confidence: conf });

export const aiBillSchema = z.object({
  is_bill: z.boolean(),
  handwritten: z.boolean(),
  language: z.string(),
  supplier_name: field(z.string()),
  supplier_gstin: field(z.string()),
  invoice_number: field(z.string()),
  /** YYYY-MM-DD */
  invoice_date: field(z.string()),
  /** Two-digit GST state code of the place of supply, if printed. */
  place_of_supply_state_code: field(z.string()),
  lines: z.array(
    z.object({
      description: field(z.string()),
      hsn: field(z.string()),
      barcode: field(z.string()),
      quantity: field(z.number()),
      unit: field(z.string()),
      rate: field(z.number()),
      discount_amount: field(z.number()),
      gst_rate_percent: field(z.number()),
      taxable_value: field(z.number()),
      line_total: field(z.number()),
      batch_number: field(z.string()),
      expiry_date: field(z.string()),
      mrp: field(z.number()),
    }),
  ),
  taxable_total: field(z.number()),
  cgst_total: field(z.number()),
  sgst_total: field(z.number()),
  igst_total: field(z.number()),
  cess_total: field(z.number()),
  other_charges: field(z.number()),
  round_off: field(z.number()),
  grand_total: field(z.number()),
  notes: z.array(z.string()),
});
export type AiBill = z.infer<typeof aiBillSchema>;

export interface AiPage {
  bytes: Buffer;
  contentType: string;
}

const PROMPT = `You are reading an Indian supplier's purchase bill / tax invoice for a small shop (it may be printed or handwritten, in English, Hindi or Marathi, and may span the pages given).
Extract it exactly as written. Rules:
- Amounts in rupees as plain numbers (no commas, no ₹). Quantities as numbers; the unit separately (kg, g, L, ml, pcs, box, case, dozen, bag…).
- rate = price of one unit BEFORE GST. If the bill only shows a GST-inclusive rate, still give the pre-GST rate if you can compute it from the taxable value, else the printed rate and lower its confidence.
- taxable_value = the line's value before GST, after discount. gst_rate_percent = total GST rate (CGST+SGST, or IGST), e.g. 5, 12, 18.
- invoice_date as YYYY-MM-DD (Indian bills write day first: 05/09/26 is 2026-09-05).
- supplier_gstin is the SELLER's 15-character GSTIN (not the buyer's). Transliterate Hindi/Marathi item names into English letters in description, keeping brand names.
- confidence 0–100 per field: how sure you are you read it correctly. Use null with confidence 0 for anything not on the bill. Never guess a GSTIN or invoice number: if unreadable, null.
- Ignore totals rows, "carried forward" rows and blank lines when listing items. If the image is not a bill, set is_bill false.`;

/** Claude reads the bill; null when it refused or returned nothing usable. */
export async function extractWithClaude(pages: AiPage[]): Promise<AiBill | null> {
  const [{ default: Anthropic }, { zodOutputFormat }] = await Promise.all([import("@anthropic-ai/sdk"), import("@anthropic-ai/sdk/helpers/zod")]);
  const client = new Anthropic();
  const content = pages.slice(0, 10).map((p) =>
    p.contentType === "application/pdf"
      ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.bytes.toString("base64") } } as const)
      : ({ type: "image", source: { type: "base64", media_type: (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(p.contentType) ? p.contentType : "image/jpeg") as "image/jpeg" | "image/png" | "image/webp", data: p.bytes.toString("base64") } } as const),
  );
  const response = await client.messages.parse({
    model: process.env.INVOICE_AI_MODEL ?? "claude-opus-5-5",
    max_tokens: 16_000,
    output_config: { effort: "low", format: zodOutputFormat(aiBillSchema) },
    messages: [{ role: "user", content: [...content, { type: "text", text: PROMPT }] }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return null;
  return response.parsed_output;
}

/** Claude reads already-extracted text (a PDF's text layer or OCR text) — cheaper than the image. */
export async function extractTextWithClaude(text: string): Promise<AiBill | null> {
  const [{ default: Anthropic }, { zodOutputFormat }] = await Promise.all([import("@anthropic-ai/sdk"), import("@anthropic-ai/sdk/helpers/zod")]);
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: process.env.INVOICE_AI_MODEL ?? "claude-opus-5-5",
    max_tokens: 16_000,
    output_config: { effort: "low", format: zodOutputFormat(aiBillSchema) },
    messages: [{ role: "user", content: [{ type: "text", text: `${PROMPT}\n\nThe bill's text:\n<bill>\n${text.slice(0, 60_000)}\n</bill>` }] }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return null;
  return response.parsed_output;
}
