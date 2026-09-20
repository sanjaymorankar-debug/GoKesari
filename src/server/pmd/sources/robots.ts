/**
 * robots.txt handling (RFC 9309), used by every HTTP-based adapter.
 *
 * The rule of the platform: a URL that robots.txt disallows for our user-agent is
 * never fetched. There is deliberately no switch to turn this off.
 *
 * Failure handling is fail-closed:
 *   200            parse and obey
 *   404 / 410      no robots file -> everything allowed
 *   401 / 403      access-controlled -> everything disallowed
 *   429 / 5xx / network error -> everything disallowed for now (short cache)
 *
 * Matching follows the RFC: the group with the longest matching user-agent token
 * wins (else "*"); within a group the longest matching path pattern wins, and
 * Allow beats Disallow on a tie. "*" is a wildcard and a trailing "$" anchors.
 */

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay?: number;
}

export interface RobotsRules {
  groups: RobotsGroup[];
}

const ALLOW_ALL: RobotsRules = { groups: [] };
const DISALLOW_ALL: RobotsRules = { groups: [{ agents: ["*"], rules: [{ allow: false, pattern: "/" }] }] };

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      // Consecutive User-agent lines share one group; a rule line ends the run.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      // "Disallow:" with an empty value means "allow everything".
      if (value === "" && field === "disallow") continue;
      current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return { groups };
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

function selectGroup(rules: RobotsRules, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  const matching = rules.groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const pool = matching.length ? matching : rules.groups.filter((g) => g.agents.includes("*"));
  if (!pool.length) return null;
  // Merge groups that name the same agent (the RFC says they combine).
  return {
    agents: pool.flatMap((g) => g.agents),
    rules: pool.flatMap((g) => g.rules),
    crawlDelay: pool.find((g) => g.crawlDelay != null)?.crawlDelay,
  };
}

export function robotsCrawlDelay(rules: RobotsRules, userAgent: string): number | undefined {
  return selectGroup(rules, userAgent)?.crawlDelay;
}

export function isAllowed(rules: RobotsRules, userAgent: string, path: string): boolean {
  const group = selectGroup(rules, userAgent);
  if (!group) return true;
  let best: { len: number; allow: boolean } | null = null;
  for (const r of group.rules) {
    if (!patternToRegExp(r.pattern).test(path)) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) {
      best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

/* ------------------------------------------------------------------ guard */

export interface RobotsFetchResult {
  status: number;
  text: string;
}

export type RobotsFetcher = (robotsUrl: string) => Promise<RobotsFetchResult>;

export interface RobotsDecision {
  allowed: boolean;
  reason: string;
  crawlDelaySeconds?: number;
}

interface CacheEntry {
  rules: RobotsRules;
  reason: string;
  expiresAt: number;
}

export class RobotsGuard {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly fetchText: RobotsFetcher,
    private readonly opts: { ttlMs?: number; errorTtlMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async load(origin: string): Promise<CacheEntry> {
    const cached = this.cache.get(origin);
    if (cached && cached.expiresAt > this.now()) return cached;

    const ttl = this.opts.ttlMs ?? 24 * 3600 * 1000;
    const errorTtl = this.opts.errorTtlMs ?? 5 * 60 * 1000;
    let entry: CacheEntry;
    try {
      const res = await this.fetchText(`${origin}/robots.txt`);
      if (res.status >= 200 && res.status < 300) {
        entry = { rules: parseRobots(res.text), reason: "robots.txt", expiresAt: this.now() + ttl };
      } else if (res.status === 404 || res.status === 410) {
        entry = { rules: ALLOW_ALL, reason: `no robots.txt (HTTP ${res.status})`, expiresAt: this.now() + ttl };
      } else if (res.status === 401 || res.status === 403) {
        entry = { rules: DISALLOW_ALL, reason: `robots.txt is access-controlled (HTTP ${res.status})`, expiresAt: this.now() + ttl };
      } else {
        entry = { rules: DISALLOW_ALL, reason: `robots.txt unavailable (HTTP ${res.status}); failing closed`, expiresAt: this.now() + errorTtl };
      }
    } catch (e) {
      entry = { rules: DISALLOW_ALL, reason: `robots.txt fetch failed (${(e as Error).message}); failing closed`, expiresAt: this.now() + errorTtl };
    }
    this.cache.set(origin, entry);
    return entry;
  }

  async check(url: string, userAgent: string): Promise<RobotsDecision> {
    const u = new URL(url);
    const entry = await this.load(u.origin);
    const allowed = isAllowed(entry.rules, userAgent, u.pathname + u.search);
    return {
      allowed,
      reason: allowed ? entry.reason : `${entry.reason}: ${u.pathname} is disallowed for ${userAgent}`,
      crawlDelaySeconds: robotsCrawlDelay(entry.rules, userAgent),
    };
  }
}
