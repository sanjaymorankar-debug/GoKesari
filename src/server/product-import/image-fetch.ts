/**
 * Downloads a product image named in an uploaded spreadsheet
 * (docs/product-import-2026-10 §4) without letting the address reach
 * GoKesari's own network (SSRF):
 *
 *  - http:// and https:// only, no user name or password in the address;
 *  - the host name is resolved and EVERY address must be public — checked at
 *    connect time by the socket's own lookup, so a DNS answer that changes
 *    between a check and the connection (rebinding) cannot slip through;
 *  - redirects are followed by hand (at most 3), each one checked the same way;
 *  - the response must say image/jpeg, image/png or image/webp, and is cut off
 *    past the size limit and after the time limit.
 *
 * The bytes are then checked again by the photo pipeline (real type from the
 * bytes, pixel limits) before anything is stored.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

import { isPrivateAddress } from "@/server/integrations/net";

export class ImageFetchError extends Error {
  constructor(
    message: string,
    readonly reason: "BAD_URL" | "BLOCKED" | "HTTP" | "TYPE" | "TOO_LARGE" | "TIMEOUT" | "NETWORK",
  ) {
    super(message);
    this.name = "ImageFetchError";
  }
}

export interface FetchImageOptions {
  maxBytes: number;
  timeoutMs: number;
  /** Replaced in tests. */
  lookup?: typeof dnsLookup;
}

export type ImageFetcher = (url: string, options: FetchImageOptions) => Promise<{ bytes: Buffer; contentType: string }>;

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const MAX_REDIRECTS = 3;

/** Throws unless `raw` is an http(s) URL with no credentials and a host that is not itself a private literal address. */
export function checkImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ImageFetchError("not a valid web address", "BAD_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ImageFetchError("only http and https addresses are allowed", "BAD_URL");
  if (url.username || url.password) throw new ImageFetchError("the address must not contain a user name or password", "BAD_URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new ImageFetchError("the address has no host", "BAD_URL");
  if (isIP(host) && isPrivateAddress(host)) throw new ImageFetchError("private and local network addresses are blocked", "BLOCKED");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new ImageFetchError("private and local network addresses are blocked", "BLOCKED");
  return url;
}

/** A lookup that refuses to hand the socket any private address. */
function guardedLookup(base: typeof dnsLookup) {
  return (
    hostname: string,
    options: unknown,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    base(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
        const blocked = new Error("private and local network addresses are blocked") as NodeJS.ErrnoException;
        blocked.code = "EBLOCKED";
        return callback(blocked, []);
      }
      const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
      if (wantsAll) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

function requestOnce(url: URL, options: FetchImageOptions): Promise<{ status: number; location?: string; contentType: string; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(
      url,
      {
        lookup: guardedLookup(options.lookup ?? dnsLookup) as unknown as typeof dnsLookup,
        headers: { "User-Agent": "GoKesari-ProductImport/1.0", Accept: "image/jpeg,image/png,image/webp" },
        timeout: options.timeoutMs,
        // No proxy and no keep-alive agent: one connection per address, checked by the lookup above.
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, location: res.headers.location, contentType: "", bytes: Buffer.alloc(0) });
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new ImageFetchError(`the server answered ${status}`, "HTTP"));
          return;
        }
        const contentType = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (!ACCEPTED_TYPES.has(contentType)) {
          res.resume();
          reject(new ImageFetchError(`not a JPEG, PNG or WebP image (${contentType || "no content type"})`, "TYPE"));
          return;
        }
        const declared = Number(res.headers["content-length"] ?? "0");
        if (declared > options.maxBytes) {
          res.destroy();
          reject(new ImageFetchError(`larger than ${Math.round(options.maxBytes / (1024 * 1024))} MB`, "TOO_LARGE"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > options.maxBytes) {
            res.destroy();
            reject(new ImageFetchError(`larger than ${Math.round(options.maxBytes / (1024 * 1024))} MB`, "TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, contentType, bytes: Buffer.concat(chunks) }));
        res.on("error", (e) => reject(new ImageFetchError(e.message, "NETWORK")));
      },
    );
    const deadline = setTimeout(() => {
      req.destroy(new ImageFetchError("took too long", "TIMEOUT"));
    }, options.timeoutMs);
    req.on("timeout", () => req.destroy(new ImageFetchError("took too long", "TIMEOUT")));
    req.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(deadline);
      if (e instanceof ImageFetchError) reject(e);
      else if (e.code === "EBLOCKED") reject(new ImageFetchError("private and local network addresses are blocked", "BLOCKED"));
      else if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") reject(new ImageFetchError("the web address could not be found", "NETWORK"));
      else if (e.code === "ECONNREFUSED" || e.code === "ECONNRESET") reject(new ImageFetchError("the image server did not answer", "NETWORK"));
      else reject(new ImageFetchError("could not be downloaded", "NETWORK"));
    });
    req.on("close", () => clearTimeout(deadline));
  });
}

/** Downloads one image; throws ImageFetchError with a short, user-readable reason. */
export const fetchImage: ImageFetcher = async (raw, options) => {
  let url = checkImageUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await requestOnce(url, options);
    if (!res.location) return { bytes: res.bytes, contentType: res.contentType };
    url = checkImageUrl(new URL(res.location, url).toString());
  }
  throw new ImageFetchError("too many redirects", "HTTP");
};
