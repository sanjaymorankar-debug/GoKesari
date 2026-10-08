/**
 * A small, strict URL parser for deciding where a link may go.
 *
 * React Native's own URL class matches with regular expressions and gets
 * hosts wrong for inputs such as `https://evil.example\@gokesari.com` (the
 * real host is evil.example). The navigation policy and the bridge's origin
 * check are the app's trust boundary, so they use this instead: it follows
 * the WHATWG rules that matter for http(s) — backslashes are path
 * separators, the fragment and query are cut before the authority is read,
 * user info ends at the last "@", hosts are lower-cased.
 */
export interface ParsedUrl {
  /** Lower-case, without ":". */
  scheme: string;
  /** Lower-case; empty for URLs without an authority (tel:, mailto:, upi:…). */
  host: string;
  /** Empty when absent or the scheme's default. */
  port: string;
  path: string;
  query: string;
  fragment: string;
}

const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

export function parseUrl(raw: string): ParsedUrl | null {
  const input = raw.trim();
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(input);
  if (!schemeMatch) return null;
  const scheme = schemeMatch[1].toLowerCase();
  let rest = input.slice(schemeMatch[0].length);
  const special = scheme === "http" || scheme === "https";
  if (special) rest = rest.replace(/\\/g, "/");

  let fragment = "";
  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) {
    fragment = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }
  let query = "";
  const queryAt = rest.indexOf("?");
  if (queryAt >= 0) {
    query = rest.slice(queryAt + 1);
    rest = rest.slice(0, queryAt);
  }

  let host = "";
  let port = "";
  let path = rest;
  if (rest.startsWith("//") || (special && rest.startsWith("/"))) {
    const afterSlashes = rest.replace(/^\/+/, "");
    const slashAt = afterSlashes.indexOf("/");
    const authority = slashAt >= 0 ? afterSlashes.slice(0, slashAt) : afterSlashes;
    path = slashAt >= 0 ? afterSlashes.slice(slashAt) : "";
    const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
    const portMatch = /:(\d*)$/.exec(hostAndPort);
    host = (portMatch ? hostAndPort.slice(0, portMatch.index) : hostAndPort).toLowerCase().replace(/\.$/, "");
    port = portMatch?.[1] ?? "";
    if (port === DEFAULT_PORTS[scheme]) port = "";
  }
  if (special && !host) return null;
  if (special && path === "") path = "/";
  return { scheme, host, port, path, query, fragment };
}

/** `https://host[:port]`, or "" for URLs without an authority. */
export function originOf(url: ParsedUrl): string {
  if (!url.host) return "";
  return `${url.scheme}://${url.host}${url.port ? `:${url.port}` : ""}`;
}

export function sameOrigin(url: string, origin: string): boolean {
  const parsed = parseUrl(url);
  const expected = parseUrl(origin);
  return Boolean(parsed && expected && originOf(parsed) !== "" && originOf(parsed) === originOf(expected));
}

/** First value of a query parameter, decoded; null when absent or malformed. */
export function queryParam(query: string, name: string): string | null {
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    if (safeDecode(key) !== name) continue;
    return safeDecode(eq >= 0 ? pair.slice(eq + 1) : "");
  }
  return null;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return null;
  }
}
