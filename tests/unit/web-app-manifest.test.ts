/** The web app manifest behind "Add to Home Screen" (src/app/manifest.ts). */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import manifest from "@/app/manifest";

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): string {
  const bytes = readFileSync(file);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

describe("web app manifest", () => {
  const m = manifest();

  it("opens full-screen at the home page", () => {
    expect(m).toMatchObject({ short_name: "GoKesari", start_url: "/", scope: "/", display: "standalone" });
  });

  it("points at icons that exist, at the sizes it declares", () => {
    const icons = m.icons ?? [];
    expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of icons) {
      expect(pngSize(path.join(__dirname, "../../public", icon.src))).toBe(icon.sizes);
    }
  });
});
