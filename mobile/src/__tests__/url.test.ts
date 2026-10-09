import { describe, expect, it } from "vitest";

import { originOf, parseUrl, queryParam, sameOrigin } from "../url";

describe("parseUrl", () => {
  it("reads ordinary website URLs", () => {
    expect(parseUrl("https://GoKesari.com/orders/42?tab=open#top")).toEqual({
      scheme: "https",
      host: "gokesari.com",
      port: "",
      path: "/orders/42",
      query: "tab=open",
      fragment: "top",
    });
    expect(parseUrl("https://gokesari.com")?.path).toBe("/");
  });

  it("finds the real host behind tricks that fool regex parsers", () => {
    expect(parseUrl("https://gokesari.com@evil.example/")?.host).toBe("evil.example");
    expect(parseUrl("https://evil.example\\@gokesari.com/")?.host).toBe("evil.example");
    expect(parseUrl("https://evil.example?@gokesari.com/")?.host).toBe("evil.example");
    expect(parseUrl("https://evil.example#@gokesari.com/")?.host).toBe("evil.example");
    expect(parseUrl("https://gokesari.com.evil.example/")?.host).toBe("gokesari.com.evil.example");
    expect(parseUrl("https://gokesari.com./")?.host).toBe("gokesari.com");
  });

  it("drops default ports and keeps others", () => {
    expect(originOf(parseUrl("https://gokesari.com:443/x")!)).toBe("https://gokesari.com");
    expect(originOf(parseUrl("http://localhost:3000/x")!)).toBe("http://localhost:3000");
  });

  it("handles URLs without an authority", () => {
    expect(parseUrl("tel:+919800000000")).toMatchObject({ scheme: "tel", host: "", path: "+919800000000" });
    expect(parseUrl("upi://pay?pa=shop@upi&am=10")).toMatchObject({ scheme: "upi", host: "pay", query: "pa=shop@upi&am=10" });
    expect(parseUrl("not a url")).toBeNull();
    expect(parseUrl("https://")).toBeNull();
  });
});

describe("sameOrigin", () => {
  it("compares scheme, host and port", () => {
    expect(sameOrigin("https://gokesari.com/wallet", "https://gokesari.com")).toBe(true);
    expect(sameOrigin("http://gokesari.com/wallet", "https://gokesari.com")).toBe(false);
    expect(sameOrigin("https://test.gokesari.com/", "https://gokesari.com")).toBe(false);
    expect(sameOrigin("https://gokesari.com@evil.example/", "https://gokesari.com")).toBe(false);
    expect(sameOrigin("about:blank", "https://gokesari.com")).toBe(false);
  });
});

describe("queryParam", () => {
  it("decodes the first value", () => {
    expect(queryParam("code=a%2Eb.c&x=1&code=2", "code")).toBe("a.b.c");
    expect(queryParam("q=hello+world", "q")).toBe("hello world");
    expect(queryParam("x=1", "code")).toBeNull();
    expect(queryParam("code=%E0%A4", "code")).toBeNull();
  });
});
