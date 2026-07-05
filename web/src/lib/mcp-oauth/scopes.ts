/**
 * MCP OAuth scope vocabulary and the scope → tool mapping.
 *
 * Scopes gate the MCP tool registry at the gateway (createPearMcpServer's
 * toolFilter) — the STDB worker token behind a grant is full-power at the
 * database layer, so this is the capability boundary for OAuth clients.
 * Names must match the registry keys in ../mcp/tools.ts.
 */

export const SCOPE_MEMORY = "memory";
export const SCOPE_PAGES_READ = "pages:read";
export const SCOPE_PAGES_WRITE = "pages:write";

export const ALL_SCOPES = [SCOPE_MEMORY, SCOPE_PAGES_READ, SCOPE_PAGES_WRITE] as const;
export type McpOauthScope = (typeof ALL_SCOPES)[number];

/** Default grant when a client omits `scope` — deliberately memory-only
 * (default-deny posture: a self-onboarded agent gets its own private memory
 * and nothing workspace-visible until a human grants more). */
export const DEFAULT_SCOPE: McpOauthScope[] = [SCOPE_MEMORY];

export const SCOPE_DESCRIPTIONS: Record<McpOauthScope, string> = {
  [SCOPE_MEMORY]: "Private memory: save and recall its own notes (invisible to other users)",
  [SCOPE_PAGES_READ]: "Read workspace pages and search their titles",
  [SCOPE_PAGES_WRITE]: "Create, edit, move, and delete workspace pages",
};

const SCOPE_TOOLS: Record<McpOauthScope, readonly string[]> = {
  [SCOPE_MEMORY]: ["remember", "list_memory", "read_memory", "search_memory"],
  [SCOPE_PAGES_READ]: ["get_page", "list_child_pages", "search_pages"],
  [SCOPE_PAGES_WRITE]: [
    "create_page",
    "update_page_content",
    "update_page_title",
    "delete_page",
    "move_page",
  ],
};

export function isKnownScope(s: string): s is McpOauthScope {
  return (ALL_SCOPES as readonly string[]).includes(s);
}

/** Parse a space-delimited scope string to known scopes; unknown entries are
 * reported so callers can reject per RFC 6749 §3.3 (invalid_scope). */
export function parseScope(scope: string | null | undefined): {
  scopes: McpOauthScope[];
  unknown: string[];
} {
  const parts = (scope ?? "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { scopes: [...DEFAULT_SCOPE], unknown: [] };
  const scopes: McpOauthScope[] = [];
  const unknown: string[] = [];
  for (const p of parts) {
    if (isKnownScope(p)) {
      if (!scopes.includes(p)) scopes.push(p);
    } else {
      unknown.push(p);
    }
  }
  return { scopes, unknown };
}

export function formatScope(scopes: readonly string[]): string {
  return scopes.join(" ");
}

/** Tool-name predicate for createPearMcpServer's toolFilter. */
export function toolFilterForScopes(scopes: readonly string[]): (tool: string) => boolean {
  const allowed = new Set<string>();
  for (const s of scopes) {
    if (isKnownScope(s)) for (const t of SCOPE_TOOLS[s]) allowed.add(t);
  }
  return (tool) => allowed.has(tool);
}

/** The scope that would grant a given tool (for actionable error messages). */
export function scopeForTool(tool: string): McpOauthScope | undefined {
  for (const s of ALL_SCOPES) {
    if (SCOPE_TOOLS[s].includes(tool)) return s;
  }
  return undefined;
}
