/**
 * Polite HTTP client for source adapters.
 *
 * Everything an adapter does over the network goes through here, so the rules
 * cannot be forgotten per-adapter:
 *
 *   - robots.txt is checked before every request AND every redirect hop;
 *   - one identifiable User-Agent with a contact address (no browser spoofing);
 *   - a minimum interval between requests to the same host (rate limit);
 *   - retries with exponential backoff + jitter on 429/5xx/network errors,
 *     honouring Retry-After, then a clear failure - never an endless loop;
 *   - a byte cap so a runaway download cannot fill a disk.
 *
 * There is no CAPTCHA handling, no proxy rotation, no header spoofing. If a site
 * answers 403/429 persistently the adapter stops; it does not escalate.
 */
import { Readable } from "node:stream";

import { RobotsGuard, type RobotsFetcher } from "./robots";

export class RobotsDisallowedError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`Blocked by robots.txt policy: ${url} (${reason})`);
    this.name = "RobotsDisallowedError";
  }
}

export class HttpError extends Error {
  constructor(public readonly url: string, public readonly status: number, message?: string) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export interface PoliteHttpOptions {
  /** e.g. "GokesariProductMaster/0.1 (+mailto:data@gokesari.com)". Must identify us and give a contact. */
  userAgent: string;
  /** Minimum gap between requests to one host. Default 1000 ms. */
  minIntervalMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class PoliteHttpClient {
  readonly userAgent: string;
  private readonly robots: RobotsGuard;
  private readonly lastRequestAt = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly opts: PoliteHttpOptions) {
    if (!/\(.*(@|https?:\/\/).*\)/.test(opts.userAgent)) {
      throw new Error("userAgent must include contact information, e.g. 'Name/1.0 (+mailto:you@example.com)'");
    }
    this.userAgent = opts.userAgent;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;

    const robotsFetcher: RobotsFetcher = async (url) => {
      const res = await this.fetchImpl(url, {
        headers: { "user-agent": this.userAgent },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        redirect: "follow",
      });
      return { status: res.status, text: res.ok ? await res.text() : "" };
    };
    this.robots = new RobotsGuard(robotsFetcher, { now: this.now });
  }

  private async throttle(host: string, crawlDelaySeconds?: number): Promise<void> {
    const gap = Math.max(this.opts.minIntervalMs ?? 1000, (crawlDelaySeconds ?? 0) * 1000);
    const last = this.lastRequestAt.get(host);
    if (last != null) {
      const wait = last + gap - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequestAt.set(host, this.now());
  }

  /** Checks policy without fetching. Adapters call this to report a blocked source early. */
  async assertAllowed(url: string): Promise<void> {
    const d = await this.robots.check(url, this.userAgent);
    if (!d.allowed) throw new RobotsDisallowedError(url, d.reason);
  }

  /**
   * GET with all policies applied. The caller owns the response body; for large
   * bodies use `streamBody` so the byte cap applies.
   */
  async get(
    url: string,
    init: {
      headers?: Record<string, string>;
      signal?: AbortSignal;
      /**
       * Large downloads: only the time to first byte is bounded here, and the caller reads
       * the body through streamBody (idle timeout + byte cap). A fixed total timeout would
       * kill a healthy long transfer.
       */
      stream?: boolean;
    } = {},
  ): Promise<Response> {
    const maxRetries = this.opts.maxRetries ?? 3;
    const base = this.opts.baseBackoffMs ?? 1000;
    const maxRedirects = this.opts.maxRedirects ?? 5;
    let attempt = 0;
    let current = url;
    let hops = 0;

    for (;;) {
      const decision = await this.robots.check(current, this.userAgent);
      if (!decision.allowed) throw new RobotsDisallowedError(current, decision.reason);
      await this.throttle(new URL(current).host, decision.crawlDelaySeconds);

      let res: Response | null = null;
      let failure: Error | null = null;
      const timeoutMs = this.opts.timeoutMs ?? 60_000;
      const controller = new AbortController();
      // Non-stream requests are bounded end to end; streams only until the headers arrive.
      const headerTimer = init.stream
        ? setTimeout(() => controller.abort(new Error("timed out waiting for response headers")), timeoutMs)
        : null;
      const signals = [controller.signal, ...(init.signal ? [init.signal] : []), ...(init.stream ? [] : [AbortSignal.timeout(timeoutMs)])];
      try {
        res = await this.fetchImpl(current, {
          headers: { "user-agent": this.userAgent, accept: "*/*", ...init.headers },
          redirect: "manual",
          signal: AbortSignal.any(signals),
        });
      } catch (e) {
        failure = e as Error;
      } finally {
        if (headerTimer) clearTimeout(headerTimer);
      }

      if (res && REDIRECTS.has(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) throw new HttpError(current, res.status, "redirect without Location");
        if (++hops > maxRedirects) throw new HttpError(current, res.status, "too many redirects");
        current = new URL(loc, current).toString(); // re-checked against robots on the next loop
        continue;
      }

      if (res && !RETRYABLE.has(res.status)) return res;

      if (attempt >= maxRetries) {
        throw failure ?? new HttpError(current, res!.status);
      }
      let delay = base * 2 ** attempt;
      const retryAfter = res?.headers.get("retry-after");
      if (retryAfter) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs)) delay = Math.max(delay, Math.min(secs, 60) * 1000);
      }
      delay += Math.floor(this.random() * base); // jitter
      attempt++;
      await this.sleep(delay);
    }
  }

  async getJson<T = unknown>(url: string, init?: { headers?: Record<string, string> }): Promise<T> {
    const res = await this.get(url, { headers: { accept: "application/json", ...init?.headers } });
    if (!res.ok) throw new HttpError(url, res.status);
    return (await res.json()) as T;
  }

  /**
   * Streams a response body as Buffers, ending the transfer (and reporting so)
   * once `maxBytes` have been read. The abort closes the connection: we never
   * pull more of a large file than the run asked for.
   */
  async *streamBody(
    res: Response,
    opts: { maxBytes: number; idleTimeoutMs?: number; onLimit?: (bytesRead: number) => void },
  ): AsyncGenerator<Buffer> {
    if (!res.ok || !res.body) throw new HttpError(res.url, res.status);
    const node = Readable.fromWeb(res.body as never);
    const idleMs = opts.idleTimeoutMs ?? 60_000;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => node.destroy(new Error(`stream idle for ${idleMs} ms`)), idleMs);
    };
    let total = 0;
    try {
      arm();
      for await (const chunk of node as AsyncIterable<Buffer>) {
        arm();
        total += chunk.length;
        if (total > opts.maxBytes) {
          opts.onLimit?.(total);
          return;
        }
        yield chunk;
      }
    } finally {
      if (idle) clearTimeout(idle);
      node.destroy();
    }
  }
}
