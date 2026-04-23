//! Custom API endpoint reducers (CRUD on endpoints, field mappings,
//! API keys) plus the HTTP-handler-facing atomic row reducers and the
//! slug / field-name validation helpers.

use spacetimedb::{reducer, ReducerContext, Table, Timestamp};

use crate::access_control::helpers::require_creator_or_admin;
use crate::api_endpoints::{
    api_call_log, api_endpoint, api_endpoint_key, api_field_mapping, database_row_marker,
    next_api_call_log_id, next_api_endpoint_id, next_api_endpoint_key_id,
    next_api_field_mapping_id, next_database_row_marker_id, slugify_field_name,
    validate_field_name, validate_slug, ApiCallLog, ApiEndpoint, ApiEndpointKey, ApiFieldMapping,
    DatabaseRowMarker, HttpMethod, PropertyValueInput,
};
use crate::pages::schemas::{
    database_schema, next_page_property_value_history_id, next_page_property_value_id,
    page_property_value, page_property_value_history, property_definition, PagePropertyValue,
    PagePropertyValueHistory, PropertyDefinition,
};
use crate::pages::{
    next_page_id, next_sort_order, page, page_content, Page, PageContent, PageType,
};
use crate::types::ActorType;

// ============================================================
// Custom API Endpoints — Reducers
// ============================================================

/// Create a custom API endpoint for a database.
/// Auto-generates field mappings for all existing PropertyDefinitions on the database.
/// The slug must be unique across all endpoints.
#[reducer]
pub fn create_api_endpoint(
    ctx: &ReducerContext,
    database_page_id: u64,
    slug: String,
    display_name: String,
    description: String,
    allowed_methods: Vec<HttpMethod>,
    require_auth: bool,
) -> Result<(), String> {
    validate_slug(&slug)?;

    if display_name.trim().is_empty() {
        return Err("Display name cannot be empty".to_string());
    }
    if allowed_methods.is_empty() {
        return Err("At least one HTTP method must be allowed".to_string());
    }

    // Verify the target page exists and is a Database.
    let page = ctx
        .db
        .page()
        .id()
        .find(database_page_id)
        .ok_or("Page not found")?;
    if page.page_type != PageType::Database {
        return Err("Target page must be a Database".to_string());
    }
    if page.deleted_at.is_some() {
        return Err("Cannot create endpoint for a deleted database".to_string());
    }

    // Check slug uniqueness (the #[unique] attribute enforces this at the DB level,
    // but a clear error message is better than a raw constraint violation).
    let slug_taken = ctx
        .db
        .api_endpoint()
        .slug()
        .find(&slug)
        .is_some();
    if slug_taken {
        return Err(format!("Slug '{}' is already in use", slug));
    }

    let endpoint = ctx.db.api_endpoint().insert(ApiEndpoint {
        id: next_api_endpoint_id(ctx),
        database_page_id,
        slug,
        display_name,
        description,
        allowed_methods,
        require_auth,
        created_by: ctx.sender(),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });

    // Auto-generate field mappings for existing properties on this database.
    let schema = ctx
        .db
        .database_schema()
        .page_id()
        .filter(&database_page_id)
        .next();
    if let Some(schema) = schema {
        let mut props: Vec<PropertyDefinition> = ctx
            .db
            .property_definition()
            .schema_id()
            .filter(&schema.id)
            .collect();
        props.sort_by_key(|p| p.order);

        let mut used_names: Vec<String> = Vec::new();
        for (i, prop) in props.iter().enumerate() {
            let mut field_name = slugify_field_name(&prop.name);
            // Deduplicate: append _2, _3, etc. if name already used
            let base = field_name.clone();
            let mut suffix = 2u32;
            while used_names.contains(&field_name) {
                field_name = format!("{}_{}", base, suffix);
                suffix += 1;
            }
            used_names.push(field_name.clone());

            ctx.db.api_field_mapping().insert(ApiFieldMapping {
                id: next_api_field_mapping_id(ctx),
                endpoint_id: endpoint.id,
                property_definition_id: prop.id,
                field_name,
                required_on_create: false,
                default_value: None,
                read_only: false,
                field_order: i as u32,
            });
        }
    }

    Ok(())
}

/// Update a custom API endpoint's configuration.
#[reducer]
pub fn update_api_endpoint(
    ctx: &ReducerContext,
    endpoint_id: u64,
    slug: String,
    display_name: String,
    description: String,
    allowed_methods: Vec<HttpMethod>,
    require_auth: bool,
) -> Result<(), String> {
    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(endpoint_id)
        .ok_or("API endpoint not found")?;

    require_creator_or_admin(ctx, endpoint.created_by, "update this endpoint")?;

    validate_slug(&slug)?;
    if display_name.trim().is_empty() {
        return Err("Display name cannot be empty".to_string());
    }
    if allowed_methods.is_empty() {
        return Err("At least one HTTP method must be allowed".to_string());
    }

    // If slug changed, check uniqueness
    if slug != endpoint.slug
        && ctx.db.api_endpoint().slug().find(&slug).is_some() {
            return Err(format!("Slug '{}' is already in use", slug));
        }

    ctx.db.api_endpoint().id().update(ApiEndpoint {
        slug,
        display_name,
        description,
        allowed_methods,
        require_auth,
        updated_at: ctx.timestamp,
        ..endpoint
    });

    Ok(())
}

/// Delete a custom API endpoint and all its field mappings and API keys.
#[reducer]
pub fn delete_api_endpoint(ctx: &ReducerContext, endpoint_id: u64) -> Result<(), String> {
    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(endpoint_id)
        .ok_or("API endpoint not found")?;

    require_creator_or_admin(ctx, endpoint.created_by, "delete this endpoint")?;

    // Remove all field mappings
    let mapping_ids: Vec<u64> = ctx
        .db
        .api_field_mapping()
        .endpoint_id()
        .filter(&endpoint_id)
        .map(|m| m.id)
        .collect();
    for mid in mapping_ids {
        ctx.db.api_field_mapping().id().delete(mid);
    }

    // Remove all API keys
    let key_ids: Vec<u64> = ctx
        .db
        .api_endpoint_key()
        .endpoint_id()
        .filter(&endpoint_id)
        .map(|k| k.id)
        .collect();
    for kid in key_ids {
        ctx.db.api_endpoint_key().id().delete(kid);
    }

    ctx.db.api_endpoint().id().delete(endpoint_id);
    Ok(())
}

/// Add or customize a field mapping on a custom API endpoint.
#[reducer]
pub fn create_api_field_mapping(
    ctx: &ReducerContext,
    endpoint_id: u64,
    property_definition_id: u64,
    field_name: String,
    required_on_create: bool,
    default_value: Option<String>,
    read_only: bool,
) -> Result<(), String> {
    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(endpoint_id)
        .ok_or("API endpoint not found")?;

    require_creator_or_admin(ctx, endpoint.created_by, "manage field mappings")?;

    validate_field_name(&field_name)?;

    // Verify property definition exists
    ctx.db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("Property definition not found")?;

    // Check field name uniqueness within this endpoint
    let name_taken = ctx
        .db
        .api_field_mapping()
        .endpoint_id()
        .filter(&endpoint_id)
        .any(|m| m.field_name == field_name);
    if name_taken {
        return Err(format!(
            "Field name '{}' is already used in this endpoint",
            field_name
        ));
    }

    let max_order = ctx
        .db
        .api_field_mapping()
        .endpoint_id()
        .filter(&endpoint_id)
        .map(|m| m.field_order)
        .max()
        .unwrap_or(0);

    ctx.db.api_field_mapping().insert(ApiFieldMapping {
        id: next_api_field_mapping_id(ctx),
        endpoint_id,
        property_definition_id,
        field_name,
        required_on_create,
        default_value,
        read_only,
        field_order: max_order + 1,
    });

    Ok(())
}

/// Update a field mapping's configuration.
#[reducer]
pub fn update_api_field_mapping(
    ctx: &ReducerContext,
    mapping_id: u64,
    field_name: String,
    required_on_create: bool,
    default_value: Option<String>,
    read_only: bool,
    field_order: u32,
) -> Result<(), String> {
    let mapping = ctx
        .db
        .api_field_mapping()
        .id()
        .find(mapping_id)
        .ok_or("Field mapping not found")?;

    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(mapping.endpoint_id)
        .ok_or("API endpoint not found")?;

    require_creator_or_admin(ctx, endpoint.created_by, "manage field mappings")?;

    validate_field_name(&field_name)?;

    // Check field name uniqueness (excluding self)
    let name_taken = ctx
        .db
        .api_field_mapping()
        .endpoint_id()
        .filter(&mapping.endpoint_id)
        .any(|m| m.id != mapping_id && m.field_name == field_name);
    if name_taken {
        return Err(format!(
            "Field name '{}' is already used in this endpoint",
            field_name
        ));
    }

    ctx.db.api_field_mapping().id().update(ApiFieldMapping {
        field_name,
        required_on_create,
        default_value,
        read_only,
        field_order,
        ..mapping
    });

    Ok(())
}

/// Remove a field from the API endpoint.
#[reducer]
pub fn delete_api_field_mapping(ctx: &ReducerContext, mapping_id: u64) -> Result<(), String> {
    let mapping = ctx
        .db
        .api_field_mapping()
        .id()
        .find(mapping_id)
        .ok_or("Field mapping not found")?;

    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(mapping.endpoint_id)
        .ok_or("API endpoint not found")?;

    require_creator_or_admin(ctx, endpoint.created_by, "manage field mappings")?;

    ctx.db.api_field_mapping().id().delete(mapping_id);
    Ok(())
}

/// Register an API key for a custom endpoint.
/// The caller generates the raw key client-side and sends only the SHA-256 hash.
/// The raw key is shown to the user once in the UI and never stored.
#[reducer]
pub fn create_api_endpoint_key(
    ctx: &ReducerContext,
    endpoint_id: u64,
    key_hash: String,
    label: String,
    allowed_methods: Vec<HttpMethod>,
    expires_at: Option<Timestamp>,
) -> Result<(), String> {
    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(endpoint_id)
        .ok_or("API endpoint not found")?;

    require_creator_or_admin(ctx, endpoint.created_by, "manage API keys")?;

    if label.trim().is_empty() {
        return Err("Key label cannot be empty".to_string());
    }
    if key_hash.len() != 64 || !key_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("key_hash must be a 64-character hex-encoded SHA-256 hash".to_string());
    }
    if allowed_methods.is_empty() {
        return Err("At least one HTTP method must be allowed for the key".to_string());
    }

    // Check for duplicate hash (key reuse)
    let hash_exists = ctx
        .db
        .api_endpoint_key()
        .iter()
        .any(|k| k.key_hash == key_hash);
    if hash_exists {
        return Err("This key hash is already registered".to_string());
    }

    ctx.db.api_endpoint_key().insert(ApiEndpointKey {
        id: next_api_endpoint_key_id(ctx),
        endpoint_id,
        key_hash,
        label,
        allowed_methods,
        created_by: ctx.sender(),
        created_at: ctx.timestamp,
        last_used_at: None,
        expires_at,
    });

    Ok(())
}

/// Revoke (delete) an API key.
#[reducer]
pub fn revoke_api_endpoint_key(ctx: &ReducerContext, key_id: u64) -> Result<(), String> {
    let key = ctx
        .db
        .api_endpoint_key()
        .id()
        .find(key_id)
        .ok_or("API key not found")?;

    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(key.endpoint_id)
        .ok_or("API endpoint not found")?;

    require_creator_or_admin(ctx, endpoint.created_by, "revoke API keys")?;

    ctx.db.api_endpoint_key().id().delete(key_id);
    Ok(())
}

// ============================================================
// Custom API Endpoints — Atomic row reducers (HTTP-handler facing)
// ============================================================
//
// These reducers exist so the HTTP layer can mutate database rows in a
// single transaction instead of chaining `create_page` + N x
// `set_property_value`. They intentionally do **not** check `created_by`
// ownership — the HTTP handler authenticates the request (session or API
// key) before invoking them and runs as the workspace's service identity.
//
// Reducers can't return values to HTTP callers, so `create_database_row`
// records the new `page_id` against a caller-supplied `client_request_id`
// in `database_row_marker`. The handler then looks up the id via SQL.

/// Atomically create a row in a database page along with all its property values.
///
/// Idempotent on `client_request_id`: a second call with the same key is a
/// no-op (still resolves to the same `page_id` via `database_row_marker`).
#[reducer]
pub fn create_database_row(
    ctx: &ReducerContext,
    database_page_id: u64,
    title: String,
    values: Vec<PropertyValueInput>,
    client_request_id: String,
) -> Result<(), String> {
    if client_request_id.is_empty() || client_request_id.len() > 128 {
        return Err("client_request_id must be 1-128 characters".to_string());
    }
    if title.trim().is_empty() {
        return Err("Title cannot be empty".to_string());
    }

    let database = ctx
        .db
        .page()
        .id()
        .find(database_page_id)
        .ok_or("Database page not found")?;
    if database.page_type != PageType::Database {
        return Err("Target page must be a Database".to_string());
    }
    if database.deleted_at.is_some() {
        return Err("Cannot create row in a deleted database".to_string());
    }

    if let Some(existing) = ctx
        .db
        .database_row_marker()
        .client_request_id()
        .find(&client_request_id)
    {
        if ctx.db.page().id().find(existing.page_id).is_some() {
            return Ok(());
        }
    }

    let sort_order = next_sort_order(ctx, Some(database_page_id));
    let row = ctx.db.page().insert(Page {
        id: next_page_id(ctx),
        parent_id: Some(database_page_id),
        sort_order,
        page_type: PageType::Database,
        title,
        icon: None,
        embedding: None,
        created_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
        parent_pk: database_page_id,
        is_hidden: false,
    });
    ctx.db.page_content().insert(PageContent {
        page_id: row.id,
        content: String::new(),
        updated_at: ctx.timestamp,
    });

    for PropertyValueInput {
        property_definition_id,
        value,
    } in values
    {
        ctx.db
            .page_property_value_history()
            .insert(PagePropertyValueHistory {
                id: next_page_property_value_history_id(ctx),
                page_id: row.id,
                property_definition_id,
                value: value.clone(),
                is_current: true,
                changed_at: ctx.timestamp,
                changed_by: ActorType::Human,
            });
        ctx.db.page_property_value().insert(PagePropertyValue {
            id: next_page_property_value_id(ctx),
            page_id: row.id,
            property_definition_id,
            value,
        });
    }

    ctx.db.database_row_marker().insert(DatabaseRowMarker {
        id: next_database_row_marker_id(ctx),
        client_request_id,
        page_id: row.id,
        created_at: ctx.timestamp,
    });

    Ok(())
}

/// Atomically update a row's title and a set of property values.
///
/// `set_values` upserts the given `(property_definition_id, value)` pairs
/// (with full history entries). `clear_values` deletes the current
/// `PagePropertyValue` for the given property ids. Pass `None` for `title`
/// to leave it unchanged.
#[reducer]
pub fn update_database_row(
    ctx: &ReducerContext,
    page_id: u64,
    title: Option<String>,
    set_values: Vec<PropertyValueInput>,
    clear_values: Vec<u64>,
) -> Result<(), String> {
    let row = ctx
        .db
        .page()
        .id()
        .find(page_id)
        .ok_or("Page not found")?;
    if row.page_type != PageType::Database {
        return Err("Target page must be a database row".to_string());
    }
    if row.deleted_at.is_some() {
        return Err("Cannot update a deleted row".to_string());
    }

    let new_title = match title {
        Some(t) => {
            if t.trim().is_empty() {
                return Err("Title cannot be empty".to_string());
            }
            t
        }
        None => row.title.clone(),
    };

    ctx.db.page().id().update(Page {
        title: new_title,
        updated_at: ctx.timestamp,
        ..row
    });

    for PropertyValueInput {
        property_definition_id,
        value,
    } in set_values
    {
        let stale: Vec<PagePropertyValueHistory> = ctx
            .db
            .page_property_value_history()
            .page_id()
            .filter(&page_id)
            .filter(|h| h.property_definition_id == property_definition_id && h.is_current)
            .collect();
        for h in stale {
            ctx.db
                .page_property_value_history()
                .id()
                .update(PagePropertyValueHistory {
                    is_current: false,
                    ..h
                });
        }
        ctx.db
            .page_property_value_history()
            .insert(PagePropertyValueHistory {
                id: next_page_property_value_history_id(ctx),
                page_id,
                property_definition_id,
                value: value.clone(),
                is_current: true,
                changed_at: ctx.timestamp,
                changed_by: ActorType::Human,
            });

        let existing: Option<PagePropertyValue> = ctx
            .db
            .page_property_value()
            .page_id()
            .filter(&page_id)
            .find(|v| v.property_definition_id == property_definition_id);
        match existing {
            Some(existing) => {
                ctx.db
                    .page_property_value()
                    .id()
                    .update(PagePropertyValue { value, ..existing });
            }
            None => {
                ctx.db.page_property_value().insert(PagePropertyValue {
                    id: next_page_property_value_id(ctx),
                    page_id,
                    property_definition_id,
                    value,
                });
            }
        }
    }

    for property_definition_id in clear_values {
        let existing: Option<PagePropertyValue> = ctx
            .db
            .page_property_value()
            .page_id()
            .filter(&page_id)
            .find(|v| v.property_definition_id == property_definition_id);
        if let Some(pv) = existing {
            ctx.db.page_property_value().id().delete(pv.id);
        }
    }

    Ok(())
}

/// Soft-delete a database row by setting `deleted_at`.
/// Idempotent — already-deleted rows succeed without modification.
#[reducer]
pub fn delete_database_row(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    let row = ctx
        .db
        .page()
        .id()
        .find(page_id)
        .ok_or("Page not found")?;
    if row.page_type != PageType::Database {
        return Err("Target page must be a database row".to_string());
    }
    if row.deleted_at.is_some() {
        return Ok(());
    }
    ctx.db.page().id().update(Page {
        deleted_at: Some(ctx.timestamp),
        updated_at: ctx.timestamp,
        ..row
    });
    Ok(())
}

/// Bump `last_used_at` on an API key. Called fire-and-forget by the HTTP
/// handler after a successful authenticated request.
#[reducer]
pub fn touch_api_endpoint_key(ctx: &ReducerContext, key_id: u64) -> Result<(), String> {
    let key = ctx
        .db
        .api_endpoint_key()
        .id()
        .find(key_id)
        .ok_or("API key not found")?;
    ctx.db.api_endpoint_key().id().update(ApiEndpointKey {
        last_used_at: Some(ctx.timestamp),
        ..key
    });
    Ok(())
}

/// Append an entry to the `ApiCallLog`. Called fire-and-forget by the HTTP
/// handler after every request (success or failure).
#[reducer]
pub fn log_api_call(
    ctx: &ReducerContext,
    endpoint_id: u64,
    key_id: Option<u64>,
    method: HttpMethod,
    path: String,
    status_code: u16,
    latency_ms: u32,
    caller_ip: Option<String>,
    error_message: Option<String>,
) -> Result<(), String> {
    if path.len() > 1024 {
        return Err("path too long".to_string());
    }
    if let Some(ref msg) = error_message {
        if msg.len() > 2048 {
            return Err("error_message too long".to_string());
        }
    }
    ctx.db.api_call_log().insert(ApiCallLog {
        id: next_api_call_log_id(ctx),
        endpoint_id,
        key_id,
        method,
        path,
        status_code,
        latency_ms,
        caller_ip,
        error_message,
        at: ctx.timestamp,
    });
    Ok(())
}
