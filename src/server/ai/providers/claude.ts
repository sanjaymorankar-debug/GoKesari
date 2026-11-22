/**
 * Claude (Anthropic) as an AI provider (docs/smart-shopping-2026-11). Reads
 * handwritten and printed photos in Indian scripts and returns structured
 * output validated against the caller's zod schema. Key: ANTHROPIC_API_KEY
 * (environment only). Model: rule smartShopping.aiModel, else
 * SMART_SHOPPING_AI_MODEL, else claude-opus-5-5.
 *
 * A decline (stop_reason "refusal") returns output null; the feature then asks
 * the user to retake the photo or type it.
 */
import type { AiProvider, AiRequest, AiResult } from "../provider";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

/** USD per million tokens (first-party API rates, Nov 2026). Unknown models log no cost. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-fable-5-2": { input: 8, output: 40 },
};

export const claudeProvider: AiProvider = {
  name: "claude",
  available: () => Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
  defaultModel: () => process.env.SMART_SHOPPING_AI_MODEL?.trim() || "claude-opus-5-5",
  pricePerMTok: (model) => PRICES[model] ?? null,

  async structured<T>(req: AiRequest<T>, model: string): Promise<AiResult<T>> {
    const [{ default: Anthropic }, { zodOutputFormat }] = await Promise.all([
      import("@anthropic-ai/sdk"),
      import("@anthropic-ai/sdk/helpers/zod"),
    ]);
    const client = new Anthropic({ timeout: 90_000, maxRetries: 2 });
    const media = (req.images ?? []).slice(0, 10).map((img) =>
      img.contentType === "application/pdf"
        ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: img.bytes.toString("base64") } } as const)
        : ({
            type: "image",
            source: {
              type: "base64",
              media_type: (IMAGE_TYPES as readonly string[]).includes(img.contentType) ? (img.contentType as ImageType) : "image/jpeg",
              data: img.bytes.toString("base64"),
            },
          } as const),
    );
    const text = req.text ? `\n\n<input>\n${req.text.slice(0, 20_000)}\n</input>` : "";
    const response = await client.messages.parse({
      model,
      max_tokens: req.maxTokens ?? 8_000,
      // Reading a list or a label is a short perception task: low effort keeps it quick and cheap.
      output_config: { effort: "low", format: zodOutputFormat(req.schema as never) },
      system: req.instructions,
      messages: [{ role: "user", content: [...media, { type: "text", text: `Read the input above and answer in the required format.${text}` }] }],
    });
    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    if (response.stop_reason === "refusal" || !response.parsed_output) return { output: null, usage, model: response.model };
    return { output: response.parsed_output as T, usage, model: response.model };
  },
};
