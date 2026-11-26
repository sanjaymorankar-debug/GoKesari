/** 1.15.0 — deferred referral link: the app's first page (src/first-open.ts). */
import { describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Set<string>());
vi.mock("expo-file-system", () => ({
  Paths: { document: "doc" },
  File: class {
    name: string;
    constructor(dir: string, name: string) {
      this.name = `${dir}/${name}`;
    }
    get exists() {
      return files.has(this.name);
    }
    create() {
      files.add(this.name);
    }
  },
}));

import { firstPageFor, takeFirstOpen } from "../first-open";

describe("first open", () => {
  it("opens /app-open once per install, never over a link the app was opened with", () => {
    expect(firstPageFor(null, true, "https://gokesari.com/", "https://gokesari.com")).toBe("https://gokesari.com/app-open");
    expect(firstPageFor(null, false, "https://gokesari.com/", "https://gokesari.com")).toBe("https://gokesari.com/");
    expect(firstPageFor("https://gokesari.com/r/GKD-AB3X9K", true, "https://gokesari.com/", "https://gokesari.com")).toBe("https://gokesari.com/r/GKD-AB3X9K");
  });
  it("is true only the first time", () => {
    expect(takeFirstOpen()).toBe(true);
    expect(takeFirstOpen()).toBe(false);
  });
});
