import { z } from "zod";

/** A product image reference: an http(s) URL, or one of our own uploads ("/api/images/<uuid>"). */
export const imageRefSchema = z
  .string()
  .max(500)
  .refine(
    (value) =>
      /^\/api\/images\/[0-9a-f-]{36}$/i.test(value) ||
      (() => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" || url.protocol === "http:";
        } catch {
          return false;
        }
      })(),
    "Use an image URL or an uploaded image.",
  );
