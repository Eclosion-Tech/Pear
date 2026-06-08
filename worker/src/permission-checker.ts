/**
 * PermissionChecker — reads ExtensionPermission rows from SpacetimeDB and
 * enforces the scope + action permission model before any tool call executes.
 *
 * Key invariants:
 *   - No row = no permission. Permissions are never defaulted.
 *   - Scope hierarchy: Page ⊂ Subtree ⊂ Workspace.
 *     A Workspace grant covers all pages; a Subtree grant covers all descendants.
 *   - HttpOutbound is always validated against the allowed_domains list.
 *     Localhost and RFC 1918 ranges are blocked unconditionally regardless of grants.
 *   - The PermissionChecker is read-only — it never mutates SpacetimeDB.
 */

import type { ConnLike } from "./tools.js";

// ── Permission type mirrors (must match SpacetimeDB enums) ───────────────────

export type PermissionScopeTag = "Page" | "Subtree" | "Workspace" | "BridgeDevice";
export type PermissionActionTag =
  | "Read"
  | "Write"
  | "Edit"
  | "Delete"
  | "Snapshot"
  | "PropertyRead"
  | "PropertyWrite"
  | "SpawnJob"
  | "HttpOutbound";

export interface PermissionScope {
  tag: PermissionScopeTag;
  /** Page/subtree/device id; undefined for Workspace. */
  value?: bigint;
}

// ── SpacetimeDB row shapes ────────────────────────────────────────────────────

type ExtensionPermissionRow = {
  id: bigint;
  installedExtensionId: bigint;
  scope: { tag: PermissionScopeTag; value?: bigint };
  action: { tag: PermissionActionTag };
  /** JSON array of allowed domain strings, or null. */
  allowedDomains: string | undefined;
};

type PageRow = {
  id: bigint;
  parentId: bigint | undefined;
};

// ── RFC 1918 + localhost blocklist ────────────────────────────────────────────

/**
 * Returns true if the domain resolves to a private/loopback address.
 * Applied unconditionally for HttpOutbound regardless of any grant.
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // Localhost and loopback
  if (h === "localhost" || h === "::1" || h.startsWith("127.")) return true;

  // RFC 1918 IPv4 ranges (heuristic — numeric check)
  // 10.x.x.x
  if (/^10\./.test(h)) return true;
  // 172.16.x.x – 172.31.x.x
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  // 192.168.x.x
  if (/^192\.168\./.test(h)) return true;
  // Link-local
  if (/^169\.254\./.test(h)) return true;

  return false;
}

// ── PermissionChecker ─────────────────────────────────────────────────────────

export class PermissionChecker {
  private readonly conn: ConnLike;

  constructor(conn: ConnLike) {
    this.conn = conn;
  }

  /**
   * Check whether the given installed extension may perform `action` on `pageId`.
   *
   * Returns { allowed: true } or { allowed: false, reason: string }.
   */
  check(
    installedExtensionId: bigint,
    pageId: bigint,
    action: PermissionActionTag,
  ): { allowed: boolean; reason?: string } {
    const grants = [
      ...(this.conn.db.extension_permission?.iter() as
        | Iterable<ExtensionPermissionRow>
        | undefined ?? []),
    ].filter(
      (p) =>
        p.installedExtensionId === installedExtensionId &&
        p.action.tag === action,
    );

    if (grants.length === 0) {
      return {
        allowed: false,
        reason: `No "${action}" permission granted for extension ${installedExtensionId}`,
      };
    }

    // Check scope hierarchy: any matching grant is sufficient
    for (const grant of grants) {
      if (this.scopeCovers(grant.scope, pageId)) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `No "${action}" permission covers page ${pageId} for extension ${installedExtensionId}`,
    };
  }

  /**
   * Resolve the unique BridgeDevice scope grant for an extension.
   * Used by tool-bash callers to auto-select device_id when possible.
   */
  resolveBridgeDevice(
    installedExtensionId: bigint,
  ): { ok: true; deviceId: bigint } | { ok: false; reason: string; candidates?: bigint[] } {
    const grants = [
      ...(this.conn.db.extension_permission?.iter() as
        | Iterable<ExtensionPermissionRow>
        | undefined ?? []),
    ].filter(
      (p) =>
        p.installedExtensionId === installedExtensionId &&
        p.scope?.tag === "BridgeDevice" &&
        p.scope?.value !== undefined,
    );

    const ids = [...new Set(grants.map((g) => g.scope.value!).map((v) => String(v)))].map(
      (s) => BigInt(s),
    );

    if (ids.length === 1) return { ok: true, deviceId: ids[0] };
    if (ids.length === 0) {
      return {
        ok: false,
        reason: `No BridgeDevice scope grant for extension ${installedExtensionId}`,
      };
    }
    return {
      ok: false,
      reason:
        `Multiple BridgeDevice scope grants for extension ${installedExtensionId}; ` +
        `device_id must be specified explicitly`,
      candidates: ids,
    };
  }

  /**
   * Check HttpOutbound permission for a specific URL.
   * Validates domain against the allowed_domains list and blocks private hosts.
   */
  checkHttpOutbound(
    installedExtensionId: bigint,
    url: string,
  ): { allowed: boolean; reason?: string } {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return { allowed: false, reason: `Invalid URL: ${url}` };
    }

    if (isPrivateHost(hostname)) {
      return {
        allowed: false,
        reason: `Outbound requests to private/loopback addresses are unconditionally blocked (${hostname})`,
      };
    }

    const grants = [
      ...(this.conn.db.extension_permission?.iter() as
        | Iterable<ExtensionPermissionRow>
        | undefined ?? []),
    ].filter(
      (p) =>
        p.installedExtensionId === installedExtensionId &&
        p.action.tag === "HttpOutbound",
    );

    if (grants.length === 0) {
      return {
        allowed: false,
        reason: `No HttpOutbound permission granted for extension ${installedExtensionId}`,
      };
    }

    for (const grant of grants) {
      if (!grant.allowedDomains) continue;
      let domains: string[];
      try {
        domains = JSON.parse(grant.allowedDomains) as string[];
      } catch {
        continue;
      }
      if (domains.some((d) => domainMatches(hostname, d))) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `Domain "${hostname}" is not in the HttpOutbound allow-list for extension ${installedExtensionId}`,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Returns true if the grant scope covers the given pageId.
   * Scope hierarchy: Workspace > Subtree > Page.
   */
  private scopeCovers(
    scope: { tag: PermissionScopeTag; value?: bigint },
    pageId: bigint,
  ): boolean {
    switch (scope.tag) {
      case "Workspace":
        return true;

      case "Subtree": {
        if (scope.value === undefined) return false;
        // Check if pageId is the subtree root or any descendant
        return scope.value === pageId || this.isDescendant(pageId, scope.value);
      }

      case "Page":
        return scope.value === pageId;

      // Not page-scoped; handled by resolveBridgeDevice.
      case "BridgeDevice":
        return false;

      default:
        return false;
    }
  }

  /**
   * Returns true if `descendantId` is a descendant of `ancestorId`
   * by walking the page parent chain.
   */
  private isDescendant(descendantId: bigint, ancestorId: bigint): boolean {
    let current: bigint | undefined = descendantId;
    const visited = new Set<bigint>();

    while (current !== undefined) {
      if (visited.has(current)) return false; // cycle guard
      visited.add(current);
      if (current === ancestorId) return true;

      const row = this.conn.db.page?.id?.find(current) as PageRow | undefined;
      current = row?.parentId;
    }

    return false;
  }
}

// ── Domain matching ───────────────────────────────────────────────────────────

/**
 * Match a hostname against an allow-list entry.
 * Wildcards are NOT supported — the install reducer rejects them.
 * Exact match only.
 */
function domainMatches(hostname: string, allowed: string): boolean {
  return hostname.toLowerCase() === allowed.toLowerCase();
}
