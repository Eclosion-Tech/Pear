//! Custom API endpoints: a stable HTTP-facing surface over a Pear
//! database. Endpoints (slug + allowed methods), per-property field
//! mappings, scoped Bearer keys, an anonymous-public lookup view for the
//! gateway, an audit log, and an idempotency marker for atomic row
//! creation.

use spacetimedb::{
    client_visibility_filter, table, view, AnonymousViewContext, Filter, Identity, ReducerContext,
    SpacetimeType, Table, Timestamp,
};

use crate::id_counters::alloc_id;
use crate::pages::schemas::PropertyValue;

pub(crate) mod reducers;

pub(crate) fn next_api_endpoint_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "api_endpoint", || {
        ctx.db.api_endpoint().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_api_field_mapping_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "api_field_mapping", || {
        ctx.db.api_field_mapping().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_api_endpoint_key_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "api_endpoint_key", || {
        ctx.db.api_endpoint_key().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_api_call_log_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "api_call_log", || {
        ctx.db.api_call_log().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_database_row_marker_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "database_row_marker", || {
        ctx.db.database_row_marker().iter().map(|r| r.id).max().unwrap_or(0)
    })
}
// ============================================================
// Custom API Endpoints — Custom Types
// ============================================================

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum HttpMethod {
    Get,
    Post,
    Patch,
    Delete,
}

/// A `(property_definition_id, value)` pair passed to the atomic row
/// reducers. Tuples aren't `SpacetimeType`, so we wrap them in a struct.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct PropertyValueInput {
    pub property_definition_id: u64,
    pub value: PropertyValue,
}

// ============================================================
// Custom API Endpoints — Tables
// ============================================================

/// A user-defined REST API endpoint that projects a clean HTTP interface
/// onto a specific Pear database. External tools can interact with workspace
/// data via /api/e/{slug} without understanding Pear internals.
#[table(accessor = api_endpoint, public)]
pub struct ApiEndpoint {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// The database page this endpoint projects.
    pub database_page_id: u64,
    /// URL path segment: /api/e/{slug}. Must be unique, lowercase, alphanumeric + hyphens.
    #[unique]
    pub slug: String,
    pub display_name: String,
    pub description: String,
    pub allowed_methods: Vec<HttpMethod>,
    pub require_auth: bool,
    pub created_by: Identity,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Maps a database property to an external-facing API field name.
/// Decouples the Pear UI column name from the API contract so renaming
/// columns doesn't break external integrations.
#[table(accessor = api_field_mapping, public)]
pub struct ApiFieldMapping {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub endpoint_id: u64,
    pub property_definition_id: u64,
    /// External-facing field name (e.g. "priority"). Lowercase, alphanumeric + underscores.
    pub field_name: String,
    pub required_on_create: bool,
    /// JSON-encoded default PropertyValue, applied when field is absent on POST.
    pub default_value: Option<String>,
    pub read_only: bool,
    pub field_order: u32,
}

/// Scoped API key for authenticating external requests to a custom endpoint.
/// Public table with row-level visibility — only the SHA-256 hash of the
/// key is stored; the raw key is shown once at creation and never
/// persisted.
///
/// RLS (see `API_ENDPOINT_KEY_FILTER` below): each row is visible to the
/// `created_by` identity (the human who minted it) and to module owners
/// (module publisher / worker / per-workspace service identity used by the API
/// gateway). That lets the workspace UI render label / created_at /
/// last_used_at to the operator who created the key, without leaking
/// those fields to other workspace members.
///
/// Anonymous Bearer-token validation by the API gateway uses the separate
/// `api_endpoint_key_lookup` view below — see its doc comment for why both
/// shapes exist.
///
/// History note: `api_endpoint_key` shipped as `private` through 0.5.1,
/// flipped to `public` in 0.5.2 (no RLS filter, transitional state),
/// then gained the RLS filter in 0.5.3. The split was forced by STDB's
/// WASM publish validator rejecting private→public + add-RLS atomically;
/// see `docs/RUNBOOKS/README.md` for the full history.
#[table(accessor = api_endpoint_key, public)]
pub struct ApiEndpointKey {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub endpoint_id: u64,
    /// SHA-256 hash of the actual API key (hex-encoded).
    pub key_hash: String,
    /// Human-readable label (e.g. "CI pipeline", "Zapier webhook").
    pub label: String,
    /// Which HTTP methods this key permits.
    pub allowed_methods: Vec<HttpMethod>,
    pub created_by: Identity,
    pub created_at: Timestamp,
    pub last_used_at: Option<Timestamp>,
    /// None = no expiry.
    pub expires_at: Option<Timestamp>,
}

/// Public projection of `api_endpoint_key` for anonymous Bearer-token
/// validation by the HTTP API gateway.
///
/// Why this still exists after `api_endpoint_key` went public-with-RLS:
/// the gateway authenticates as the per-workspace service identity (NOT
/// the human creator), which is unrelated to any `created_by`. The RLS
/// filter on the real table correctly hides every row from it. This view
/// is anonymous public and bypasses RLS, re-exposing only the fields a
/// Bearer-token check needs (`key_hash`, `endpoint_id`, `allowed_methods`,
/// `expires_at`, plus the row id for audit logging). Callers query it via
/// SQL with a `WHERE key_hash = '…'` filter.
///
/// Security note: `key_hash` is the SHA-256 of a 256-bit random secret, so
/// publishing it in this projection does not let an attacker forge auth — the
/// plaintext token is still required in the `Authorization` header. Fields
/// that DO leak metadata (`label`, `created_by`, `created_at`, `last_used_at`)
/// stay on the underlying table behind RLS.
#[derive(SpacetimeType, Clone, Debug)]
pub struct ApiEndpointKeyLookupRow {
    pub id: u64,
    pub endpoint_id: u64,
    pub key_hash: String,
    pub allowed_methods: Vec<HttpMethod>,
    pub expires_at: Option<Timestamp>,
}

/// Row-level visibility filter for `api_endpoint_key`. Each row is visible
/// to the `created_by` identity (the human who minted the key); module
/// owners (module publisher / worker / per-workspace gateway service identity)
/// bypass this filter automatically and see every row, which is required
/// for the gateway's bearer-token resolution and for backfills.
///
/// We deliberately do NOT join through `api_endpoint.created_by` here:
/// keys are scoped per-mint, not per-endpoint. If endpoint ownership
/// changes (today there's no UI for this; tomorrow there might be), each
/// minter still controls their own keys until they explicitly revoke.
///
/// **DO NOT remove this filter without also flipping the table back to
/// `private`.** Adding RLS to a table that was `private` in the previous
/// published WASM trips STDB's publish validator with
/// `Cannot define RLS rule on private table` and blocks the upgrade for
/// every workspace on the pool — that's how this filter was forced into
/// its own 0.5.3 release in the first place.
#[client_visibility_filter]
const API_ENDPOINT_KEY_FILTER: Filter = Filter::Sql(
    "SELECT * FROM api_endpoint_key WHERE created_by = :sender",
);

#[view(accessor = api_endpoint_key_lookup, public)]
fn api_endpoint_key_lookup(ctx: &AnonymousViewContext) -> Vec<ApiEndpointKeyLookupRow> {
    // View bodies can't call `.iter()` (the view handle deliberately omits
    // `Table`); we full-scan via the `endpoint_id` btree index with an
    // unbounded range. The materialised vec is then SQL-filterable by callers
    // (`SELECT … WHERE key_hash = '…' AND endpoint_id = …`).
    ctx.db
        .api_endpoint_key()
        .endpoint_id()
        .filter(0u64..)
        .map(|k| ApiEndpointKeyLookupRow {
            id: k.id,
            endpoint_id: k.endpoint_id,
            key_hash: k.key_hash,
            allowed_methods: k.allowed_methods,
            expires_at: k.expires_at,
        })
        .collect()
}

/// Audit log for every external HTTP call made through a custom API endpoint.
/// Public so the workspace UI can render a "Recent calls" panel without
/// admin privileges. Insert-only; older rows are pruned by ops tooling.
#[table(accessor = api_call_log, public)]
pub struct ApiCallLog {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub endpoint_id: u64,
    /// None when the request authenticated via session instead of an API key.
    pub key_id: Option<u64>,
    pub method: HttpMethod,
    /// Original request path (e.g. "/e/fruit/42"). Truncated to 1024 chars.
    pub path: String,
    pub status_code: u16,
    pub latency_ms: u32,
    /// Best-effort caller IP (X-Forwarded-For first hop).
    pub caller_ip: Option<String>,
    /// Short error string when `status_code >= 400`. None on success.
    pub error_message: Option<String>,
    #[index(btree)]
    pub at: Timestamp,
}

/// Idempotency + id-resolution marker for atomic database-row creation
/// from the HTTP handler. Reducers can't return values to HTTP callers,
/// so the handler generates a UUID, passes it as `client_request_id`, and
/// then SQL-queries this table for the resulting `page_id`.
///
/// A second `create_database_row` call with the same key is a no-op.
#[table(accessor = database_row_marker, public)]
pub struct DatabaseRowMarker {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[unique]
    pub client_request_id: String,
    pub page_id: u64,
    pub created_at: Timestamp,
}


/// Slugs that would collide with system routes the HTTP handler reserves
/// (`/_schema`, `/_health`, `/_meta`) or with namespace conventions an
/// operator might add later. The leading-underscore variants are belt-and-
/// braces — the slug regex below already rejects underscores.
const RESERVED_API_SLUGS: &[&str] = &[
    "_schema", "_health", "_meta", "_admin", "_internal",
    "schema", "health", "meta", "admin", "internal", "system",
    "api", "auth", "openapi", "docs",
];

/// Validate a slug: lowercase, alphanumeric + hyphens, 1-64 chars, no leading/trailing hyphens.
pub(crate) fn validate_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty() || slug.len() > 64 {
        return Err("Slug must be 1-64 characters".to_string());
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("Slug must contain only lowercase letters, digits, and hyphens".to_string());
    }
    if slug.starts_with('-') || slug.ends_with('-') {
        return Err("Slug must not start or end with a hyphen".to_string());
    }
    if slug.starts_with('_') {
        return Err("Slug must not start with an underscore (reserved)".to_string());
    }
    if RESERVED_API_SLUGS.contains(&slug) {
        return Err(format!("Slug '{}' is reserved", slug));
    }
    Ok(())
}

/// Validate a field name: lowercase, alphanumeric + underscores, 1-64 chars.
pub(crate) fn validate_field_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("Field name must be 1-64 characters".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(
            "Field name must contain only lowercase letters, digits, and underscores".to_string(),
        );
    }
    if name.starts_with('_') {
        return Err("Field name must not start with an underscore".to_string());
    }
    Ok(())
}

/// Derive a snake_case field name from a property display name.
pub(crate) fn slugify_field_name(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    // Collapse consecutive underscores and trim leading/trailing ones
    let mut result = String::new();
    let mut prev_underscore = true; // treat start as underscore to trim leading
    for c in slug.chars() {
        if c == '_' {
            if !prev_underscore {
                result.push('_');
            }
            prev_underscore = true;
        } else {
            result.push(c);
            prev_underscore = false;
        }
    }
    if result.ends_with('_') {
        result.pop();
    }
    if result.is_empty() {
        "field".to_string()
    } else {
        result
    }
}
