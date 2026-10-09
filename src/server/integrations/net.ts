/**
 * Outbound address check for shop-supplied URLs (Module 2: the shop's Odoo
 * address). GoKesari calls that URL from its own server, so it must not be
 * usable to reach GoKesari's internal network (SSRF): HTTPS only, and the
 * host must resolve to public addresses. Local development may use http://localhost.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { IntegrationError } from "./errors";

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true;
  if (s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  return mapped ? isPrivateV4(mapped[1]) : false;
}

export function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 6 ? isPrivateV6(ip) : isPrivateV4(ip);
}

const allowLocal = () => process.env.NODE_ENV !== "production";

/** Throws unless `raw` is an https URL whose host resolves only to public addresses. */
export async function assertPublicUrl(raw: string, lookupFn: typeof lookup = lookup): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IntegrationError("NOT_CONFIGURED", `Not a valid address: ${raw}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (allowLocal() && url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) return;
  if (url.protocol !== "https:") throw new IntegrationError("NOT_CONFIGURED", "The software's address must start with https://");
  if (url.username || url.password) throw new IntegrationError("NOT_CONFIGURED", "The address must not contain a user name or password.");
  const addresses = isIP(host) ? [{ address: host }] : await lookupFn(host, { all: true }).catch(() => {
    throw new IntegrationError("UNREACHABLE", `${host} could not be found (DNS).`);
  });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new IntegrationError("NOT_CONFIGURED", `${host} is a private or local address; GoKesari can only reach software on the internet.`);
  }
}
