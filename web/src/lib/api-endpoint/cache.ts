/**
 * Tiny LRU cache with TTL for endpoint configurations. Used by the
 * Cloudflare Worker (and optionally by the OSS Next.js handler) so that
 * steady-state requests skip the SQL round-trip to load the endpoint
 * + field mappings + property definitions.
 *
 * Entries are invalidated by TTL only — endpoint config changes propagate
 * within `ttlMs` (default: 60s). Callers that need stronger consistency
 * can pass `force: true` to `get()` or call `delete()` explicitly.
 */

import type { EndpointConfig } from "./types";

interface Entry {
  config: EndpointConfig;
  expiresAt: number;
}

export interface EndpointConfigCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  /** Allows tests to inject a clock. Defaults to `Date.now`. */
  now?: () => number;
}

export class EndpointConfigCache {
  private readonly map = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: EndpointConfigCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 256;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): EndpointConfig | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.config;
  }

  set(key: string, config: EndpointConfig): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { config, expiresAt: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
