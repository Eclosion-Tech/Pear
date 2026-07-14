//! Database schemas: column structure for `Database` pages, the cells
//! that store the current value (`PagePropertyValue`), and an
//! append-only history of every change (`PagePropertyValueHistory`).

use spacetimedb::{reducer, table, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::access_control::helpers::require_page_write;
use crate::automations::enqueue_property_changed;
use crate::id_counters::alloc_id;
use crate::pages::{page, ActorType};

/// Resolve a schema to its owning page and require write access on it.
/// Structural schema reducers (columns, config, inheritance) carry only a
/// `schema_id`; this maps that back to the page the access rules live on.
pub(crate) fn require_schema_write(ctx: &ReducerContext, schema_id: u64) -> Result<(), String> {
    let schema = ctx
        .db
        .database_schema()
        .id()
        .find(schema_id)
        .ok_or("Schema not found")?;
    require_page_write(ctx, schema.page_id)
}

/// Resolve a property definition -> schema -> owning page and require write.
pub(crate) fn require_property_write(
    ctx: &ReducerContext,
    property_definition_id: u64,
) -> Result<(), String> {
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    require_schema_write(ctx, prop.schema_id)
}

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
    /// File/image attachments on a row (Notion "Files & media" equivalent).
    /// Values are `PropertyValue::File` lists of workspace blobs or external
    /// URLs.
    File,
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
    /// Files attached to a File-type property cell.
    File(Vec<FileRef>),
}

/// One file in a File-type property cell. Exactly one of `object_id`
/// (workspace blob, rendered via the blob route with the current workspace
/// slug — id rather than URL so snapshots restore across slugs) or
/// `external_url` is non-empty.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct FileRef {
    pub name: String,
    pub object_id: String,
    pub external_url: String,
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
    /// OOP-style schema inheritance. When set, this schema's *effective*
    /// columns are the ancestor chain's `PropertyDefinition`s (root-first)
    /// followed by its own. Inherited columns keep their original
    /// `property_definition_id`, so `PagePropertyValue` rows on child-db
    /// pages reference parent definitions directly — no copying, no ID
    /// remapping. Single inheritance only; cycles are rejected by
    /// `set_schema_parent`.
    #[default(None::<u64>)]
    pub parent_schema_id: Option<u64>,
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
// Schema inheritance helpers
// ============================================================

/// Hard cap on inheritance depth. Generous for real use; bounds the walk
/// if data is ever corrupted into a cycle despite the reducer guard.
const MAX_SCHEMA_CHAIN_DEPTH: usize = 32;

/// Per-schema system columns that are intentionally present on every
/// schema (seeded, not user-created). Exempt from shadowing checks so
/// linking two seeded schemas doesn't spuriously conflict.
const SYSTEM_PROPERTY_NAMES: &[&str] = &["agent_instruction"];

/// Ancestor chain for a schema, child-first: `[schema_id, parent, ...]`.
/// Stops at the root, at a dangling parent reference, or at
/// `MAX_SCHEMA_CHAIN_DEPTH`.
pub(crate) fn schema_ancestor_chain(ctx: &ReducerContext, schema_id: u64) -> Vec<u64> {
    let mut chain = Vec::new();
    let mut current = Some(schema_id);
    while let Some(id) = current {
        if chain.contains(&id) || chain.len() >= MAX_SCHEMA_CHAIN_DEPTH {
            break;
        }
        chain.push(id);
        current = ctx
            .db
            .database_schema()
            .id()
            .find(id)
            .and_then(|s| s.parent_schema_id);
    }
    chain
}

/// Direct + transitive child schema ids of `schema_id` (excluding itself).
/// Full-scan BFS — the schema table holds one row per database, so this
/// stays small.
pub(crate) fn schema_descendants(ctx: &ReducerContext, schema_id: u64) -> Vec<u64> {
    let all: Vec<(u64, Option<u64>)> = ctx
        .db
        .database_schema()
        .iter()
        .map(|s| (s.id, s.parent_schema_id))
        .collect();
    let mut found: Vec<u64> = Vec::new();
    let mut frontier = vec![schema_id];
    while let Some(pid) = frontier.pop() {
        for (id, parent) in &all {
            if *parent == Some(pid) && !found.contains(id) {
                found.push(*id);
                frontier.push(*id);
            }
        }
    }
    found
}

/// Resolved column set for a schema: ancestor definitions root-first,
/// own definitions last, each schema's block sorted by `order`. Inherited
/// definitions keep their original ids — write paths need no remapping.
pub(crate) fn effective_property_definitions(
    ctx: &ReducerContext,
    schema_id: u64,
) -> Vec<PropertyDefinition> {
    let mut defs = Vec::new();
    for sid in schema_ancestor_chain(ctx, schema_id).into_iter().rev() {
        let mut block: Vec<PropertyDefinition> =
            ctx.db.property_definition().schema_id().filter(&sid).collect();
        block.sort_by_key(|p| p.order);
        defs.extend(block);
    }
    defs
}

/// No-shadowing rule (v1): a property name must be unique across a
/// schema's whole inheritance chain — ancestors *and* descendants — so
/// the effective column set is unambiguous everywhere. Returns the id of
/// the schema that already defines `name`, if any.
fn find_shadowing_conflict(ctx: &ReducerContext, schema_id: u64, name: &str) -> Option<u64> {
    if SYSTEM_PROPERTY_NAMES.contains(&name) {
        return None;
    }
    let mut related: Vec<u64> = schema_ancestor_chain(ctx, schema_id);
    related.extend(schema_descendants(ctx, schema_id));
    related.retain(|sid| *sid != schema_id);
    related.into_iter().find(|sid| {
        ctx.db
            .property_definition()
            .schema_id()
            .filter(sid)
            .any(|p| p.name == name)
    })
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
    require_page_write(ctx, page_id)?;
    ctx.db.database_schema().insert(DatabaseSchema {
        id: next_database_schema_id(ctx),
        page_id,
        name,
        config: None,
        parent_schema_id: None,
    });
    Ok(())
}

/// Link (or unlink, with `None`) a schema to a parent schema. The child's
/// effective columns become the parent chain's definitions plus its own —
/// see `effective_property_definitions`. Rejects self-parenting, cycles,
/// and links that would shadow a property name anywhere in the combined
/// chain (v1 has no override semantics).
#[reducer]
pub fn set_schema_parent(
    ctx: &ReducerContext,
    schema_id: u64,
    parent_schema_id: Option<u64>,
) -> Result<(), String> {
    require_schema_write(ctx, schema_id)?;
    let schema = ctx
        .db
        .database_schema()
        .id()
        .find(schema_id)
        .ok_or("Schema not found")?;

    if let Some(parent_id) = parent_schema_id {
        if parent_id == schema_id {
            return Err("A schema cannot inherit from itself".to_string());
        }
        ctx.db
            .database_schema()
            .id()
            .find(parent_id)
            .ok_or("Parent schema not found")?;

        // Cycle guard: the proposed parent's ancestor chain must not pass
        // through this schema (or any of its descendants — equivalent check,
        // since descendants chain through schema_id).
        if schema_ancestor_chain(ctx, parent_id).contains(&schema_id) {
            return Err("Cannot set parent: would create an inheritance cycle".to_string());
        }

        // No-shadowing: every name defined in this schema's subtree must be
        // absent from the new ancestor chain.
        let new_ancestors = schema_ancestor_chain(ctx, parent_id);
        let mut subtree = vec![schema_id];
        subtree.extend(schema_descendants(ctx, schema_id));
        for sid in &subtree {
            for prop in ctx.db.property_definition().schema_id().filter(sid) {
                if SYSTEM_PROPERTY_NAMES.contains(&prop.name.as_str()) {
                    continue;
                }
                let clash = new_ancestors.iter().any(|aid| {
                    ctx.db
                        .property_definition()
                        .schema_id()
                        .filter(aid)
                        .any(|p| p.name == prop.name)
                });
                if clash {
                    return Err(format!(
                        "Cannot set parent: property \"{}\" exists in both the parent chain and this schema's chain",
                        prop.name
                    ));
                }
            }
        }
    }

    ctx.db.database_schema().id().update(DatabaseSchema {
        parent_schema_id,
        ..schema
    });
    Ok(())
}

#[reducer]
pub fn update_database_schema_config(
    ctx: &ReducerContext,
    schema_id: u64,
    config: String,
) -> Result<(), String> {
    require_schema_write(ctx, schema_id)?;
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
    require_schema_write(ctx, schema_id)?;
    ctx.db
        .database_schema()
        .id()
        .find(schema_id)
        .ok_or("Schema not found")?;
    if let Some(other) = find_shadowing_conflict(ctx, schema_id, &name) {
        return Err(format!(
            "Property \"{name}\" already exists on a related schema (id {other}) in this inheritance chain"
        ));
    }
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
    require_property_write(ctx, property_definition_id)?;
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
    require_property_write(ctx, property_definition_id)?;
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
    require_property_write(ctx, property_definition_id)?;
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    if name != prop.name {
        if let Some(other) = find_shadowing_conflict(ctx, prop.schema_id, &name) {
            return Err(format!(
                "Property \"{name}\" already exists on a related schema (id {other}) in this inheritance chain"
            ));
        }
    }
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
    require_property_write(ctx, property_definition_id)?;
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
    require_property_write(ctx, property_definition_id)?;
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
    set_property_value_inner(ctx, page_id, property_definition_id, value, ActorType::Human)
}

/// Body of `set_property_value`, minus the sender ACL gate — the live
/// automation executor calls this after checking the rule's `run_as`
/// authority instead, stamping the automation as the changing actor.
pub(crate) fn set_property_value_inner(
    ctx: &ReducerContext,
    page_id: u64,
    property_definition_id: u64,
    value: PropertyValue,
    changed_by: ActorType,
) -> Result<(), String> {
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
            changed_by,
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
