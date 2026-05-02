//! Database schemas: column structure for `Database` pages, the cells
//! that store the current value (`PagePropertyValue`), and an
//! append-only history of every change (`PagePropertyValueHistory`).

use spacetimedb::{reducer, table, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::access_control::helpers::require_page_write;
use crate::automations::enqueue_property_changed;
use crate::id_counters::alloc_id;
use crate::pages::{page, ActorType};

pub(crate) fn next_database_schema_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "database_schema", || {
        ctx.db
            .database_schema()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_property_definition_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "property_definition", || {
        ctx.db
            .property_definition()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_page_property_value_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "page_property_value", || {
        ctx.db
            .page_property_value()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_page_property_value_history_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "page_property_value_history", || {
        ctx.db
            .page_property_value_history()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum PropertyType {
    Text,
    Number,
    Date,
    Select,
    MultiSelect,
    Relation,
    Checkbox,
    Url,
    Person,
    /// Computed by an AI primitive over other columns of the same row.
    /// Configuration (primitive, model, prompt, output schema, invalidation
    /// policy) lives in `PropertyDefinition.config` as JSON; current
    /// materialised value lives in the same `PagePropertyValue` row as
    /// any other column. Evaluation history (cache + cost) lives in
    /// `AiEvaluation`.
    Ai,
    /// Expression stored in PropertyDefinition.config as { "expression": "..." }.
    /// Evaluated client-side in real time against sibling property values.
    Formula,
    /// Aggregation over related rows. Config: { "relationPropertyId": u64, "rollupPropertyId": u64, "function": "sum"|"count"|... }
    /// Evaluated client-side from subscribed related row data.
    Rollup,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum PropertyValue {
    Text(String),
    Number(f64),
    Date(u64),
    Select(String),
    MultiSelect(Vec<String>),
    Relation(Vec<u64>),
    Checkbox(bool),
    Url(String),
    /// Identity hex strings of assigned users.
    Person(Vec<String>),
    /// Materialised AI primitive output, paired with the `AiEvaluation.id`
    /// it was produced by so the UI can show provenance and cost without a
    /// separate query.
    Ai(AiPropertyValue),
}

/// Materialised value of an AI column. The output is intentionally a
/// `String` even for "extract" / "classify" — the rendering layer reads
/// the column's `output_schema_json` to decide how to display it (chip,
/// number, sub-table, etc.). Storing as a string also keeps the cell
/// schema-stable when the prompt's output schema evolves.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct AiPropertyValue {
    pub output: String,
    pub evaluation_id: u64,
    pub is_stale: bool,
}

/// Set of supported AI primitives. Each maps to a worker handler that
/// validates output against `AiColumnConfig.output_schema_json` before
/// committing.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum AiPrimitive {
    /// Pick one of N labels.
    Classify,
    /// Pull structured fields out of input text.
    Extract,
    /// Compress to N words/sentences.
    Summarize,
    /// Score Positive / Negative / Neutral with confidence.
    Sentiment,
    /// Translate to a target language.
    Translate,
}

/// Controls when a materialised `AiPropertyValue` is considered stale.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum InvalidationPolicy {
    /// Recompute whenever any column referenced by `AiColumnConfig.input_columns`
    /// changes on the row. Default for most primitives.
    OnInputChange,
    /// Never auto-recompute — only manual `recompute_ai_cell`. Useful for
    /// expensive primitives where the operator wants to manage cost.
    Manual,
    /// Never invalidate. Useful for one-shot enrichment.
    Never,
}

/// Column structure definition for a Database page.
#[table(accessor = database_schema, public)]
pub struct DatabaseSchema {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub name: String,
    /// JSON config for schema-level settings (e.g. name column default).
    #[default(None::<String>)]
    pub config: Option<String>,
}

/// Each column in a database schema.
#[table(accessor = property_definition, public)]
pub struct PropertyDefinition {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub schema_id: u64,
    pub name: String,
    pub property_type: PropertyType,
    pub config: String,
    pub order: u32,
}

/// Current property value for a page (row).
#[table(accessor = page_property_value, public)]
pub struct PagePropertyValue {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    #[index(btree)]
    pub property_definition_id: u64,
    pub value: PropertyValue,
}

/// Append-only history of every property value change.
#[table(accessor = page_property_value_history, public)]
pub struct PagePropertyValueHistory {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    #[index(btree)]
    pub property_definition_id: u64,
    pub value: PropertyValue,
    pub is_current: bool,
    pub changed_at: Timestamp,
    pub changed_by: ActorType,
}

// ============================================================
// Schema Reducers
// ============================================================

#[reducer]
pub fn create_database_schema(
    ctx: &ReducerContext,
    page_id: u64,
    name: String,
) -> Result<(), String> {
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    ctx.db.database_schema().insert(DatabaseSchema {
        id: next_database_schema_id(ctx),
        page_id,
        name,
        config: None,
    });
    Ok(())
}

#[reducer]
pub fn update_database_schema_config(
    ctx: &ReducerContext,
    schema_id: u64,
    config: String,
) -> Result<(), String> {
    let mut schema = ctx
        .db
        .database_schema()
        .id()
        .find(schema_id)
        .ok_or("Schema not found")?;
    schema.config = Some(config);
    ctx.db.database_schema().id().update(schema);
    Ok(())
}

#[reducer]
pub fn add_property(
    ctx: &ReducerContext,
    schema_id: u64,
    name: String,
    property_type: PropertyType,
    config: String,
) -> Result<(), String> {
    ctx.db
        .database_schema()
        .id()
        .find(schema_id)
        .ok_or("Schema not found")?;
    let max_order = ctx
        .db
        .property_definition()
        .schema_id()
        .filter(&schema_id)
        .map(|p| p.order)
        .max()
        .unwrap_or(0);
    ctx.db.property_definition().insert(PropertyDefinition {
        id: next_property_definition_id(ctx),
        schema_id,
        name,
        property_type,
        config,
        order: max_order + 1,
    });
    Ok(())
}

#[reducer]
pub fn reorder_property(
    ctx: &ReducerContext,
    property_definition_id: u64,
    new_order: u32,
) -> Result<(), String> {
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    ctx.db
        .property_definition()
        .id()
        .update(PropertyDefinition {
            order: new_order,
            ..prop
        });
    Ok(())
}

#[reducer]
pub fn delete_property(ctx: &ReducerContext, property_definition_id: u64) -> Result<(), String> {
    ctx.db
        .property_definition()
        .id()
        .delete(property_definition_id);
    Ok(())
}

#[reducer]
pub fn rename_property(
    ctx: &ReducerContext,
    property_definition_id: u64,
    name: String,
) -> Result<(), String> {
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    ctx.db
        .property_definition()
        .id()
        .update(PropertyDefinition { name, ..prop });
    Ok(())
}

#[reducer]
pub fn update_property_config(
    ctx: &ReducerContext,
    property_definition_id: u64,
    config: String,
) -> Result<(), String> {
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    ctx.db
        .property_definition()
        .id()
        .update(PropertyDefinition { config, ..prop });
    Ok(())
}

#[reducer]
pub fn update_property_type(
    ctx: &ReducerContext,
    property_definition_id: u64,
    property_type: PropertyType,
) -> Result<(), String> {
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    ctx.db
        .property_definition()
        .id()
        .update(PropertyDefinition {
            property_type,
            config: "{}".to_string(),
            ..prop
        });
    Ok(())
}

/// Seed the agent_instruction PropertyDefinition for a database schema.
/// Idempotent — no-op if the property already exists for this schema.
/// Called for new schemas or as a one-time migration for pre-existing workspaces.
/// Workers call discover_instruction_pages gracefully if this property is absent.
#[reducer]
pub fn seed_agent_instruction_property(ctx: &ReducerContext, schema_id: u64) -> Result<(), String> {
    ctx.db
        .database_schema()
        .id()
        .find(schema_id)
        .ok_or("Database schema not found")?;

    let already_exists = ctx
        .db
        .property_definition()
        .schema_id()
        .filter(&schema_id)
        .any(|p| p.name == "agent_instruction");

    if already_exists {
        return Ok(());
    }

    ctx.db.property_definition().insert(PropertyDefinition {
        id: next_property_definition_id(ctx),
        schema_id,
        name: "agent_instruction".to_string(),
        property_type: PropertyType::Checkbox,
        config: "{}".to_string(),
        order: 0,
    });

    Ok(())
}

// ============================================================
// Property Value Reducers
// ============================================================

/// Upserts the current value and appends an immutable history row.
#[reducer]
pub fn set_property_value(
    ctx: &ReducerContext,
    page_id: u64,
    property_definition_id: u64,
    value: PropertyValue,
) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    // Collect existing current-history entries before mutating
    let stale_history: Vec<PagePropertyValueHistory> = ctx
        .db
        .page_property_value_history()
        .page_id()
        .filter(&page_id)
        .filter(|h| h.property_definition_id == property_definition_id && h.is_current)
        .collect();

    for hist in stale_history {
        ctx.db
            .page_property_value_history()
            .id()
            .update(PagePropertyValueHistory {
                is_current: false,
                ..hist
            });
    }

    // Append new history entry (clone value — it's also needed for upsert below)
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

    // Collect existing current value before mutating
    let existing_value: Option<PagePropertyValue> = ctx
        .db
        .page_property_value()
        .page_id()
        .filter(&page_id)
        .find(|v| v.property_definition_id == property_definition_id);

    match existing_value {
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

    enqueue_property_changed(ctx, page_id, property_definition_id);
    Ok(())
}

#[reducer]
pub fn clear_property_value(
    ctx: &ReducerContext,
    page_id: u64,
    property_definition_id: u64,
) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    let existing: Option<PagePropertyValue> = ctx
        .db
        .page_property_value()
        .page_id()
        .filter(&page_id)
        .find(|v| v.property_definition_id == property_definition_id);

    if let Some(row) = existing {
        ctx.db.page_property_value().id().delete(row.id);
        enqueue_property_changed(ctx, page_id, property_definition_id);
    }
    Ok(())
}
