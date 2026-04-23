//! Structural sensors: cheap deterministic checks over the relational
//! substrate. `SensorRegistry` is the closed vocabulary;
//! `StructuralSensorFinding` is the rolling output. The `run_*_sensor`
//! reducers are scheduled by an Orcha worker; `seed_sensor_registry_inner`
//! is called from the module `#[reducer(init)]` hook.

use spacetimedb::{reducer, table, ReducerContext, Table, Timestamp};

use crate::auth::sender_is_admin;
use crate::extensions::tool_call_audit_log;
use crate::id_counters::alloc_id;
use crate::pages::page;
use crate::pages::schemas::{
    database_schema, page_property_value, property_definition, PropertyType, PropertyValue,
};

pub(crate) fn next_sensor_registry_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "sensor_registry", || {
        ctx.db.sensor_registry().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_structural_sensor_finding_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "structural_sensor_finding", || {
        ctx.db.structural_sensor_finding().iter().map(|r| r.id).max().unwrap_or(0)
    })
}
/// Registry of valid structural-sensor `(sensor_kind, code)` pairs. This
/// turns the previously open string fields on `StructuralSensorFinding`
/// into a closed vocabulary: the `upsert_finding` helper validates
/// against this table and refuses unknown kinds/codes, so a typo in a
/// sensor reducer can't quietly produce a finding the UI doesn't know how
/// to render.
///
/// Seeded at `init` time with every shipped sensor; new sensors register
/// by adding a row in `seed_sensor_registry_inner`. Callers (other than
/// the seed) cannot insert here — admins can adjust `default_severity`
/// or `description` via reducers added later if needed.
#[table(
    accessor = sensor_registry,
    public,
    index(accessor = sensor_registry_kind_code, btree(columns = [sensor_kind, code])),
)]
pub struct SensorRegistry {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Sensor identifier (e.g. `"orphan_detector"`).
    pub sensor_kind: String,
    /// Specific rule code within the sensor (e.g. `"page_parent_missing"`).
    pub code: String,
    /// Human-readable name shown in the Inbox / settings UI.
    pub display_name: String,
    /// One-paragraph explanation of what this finding means.
    pub description: String,
    /// Default severity emitted by the sensor: `"info"`, `"warn"`, `"error"`.
    /// The sensor may override per-finding, but this is the canonical class.
    pub default_severity: String,
}

/// Findings emitted by computational structural sensors (orphan detector,
/// relational integrity, schema consistency, convention sensor). These are
/// cheap deterministic checks over the relational substrate; an Orcha worker
/// invokes the corresponding `run_*_sensor` reducer on a schedule and the
/// reducer (re)writes findings here.
///
/// `sensor_kind` + `code` MUST appear in `SensorRegistry`; the
/// `upsert_finding` helper enforces this. This makes the sensor surface a
/// closed, governed vocabulary rather than an open string-typed sink.
///
/// Findings are *advisory* — they surface in the Inbox / Members tab and
/// optionally feed review agents; they do not block writes. Each row is
/// keyed by `(sensor_kind, target_kind, target_id, code)` so re-runs
/// upsert rather than spam.
#[table(
    accessor = structural_sensor_finding,
    public,
    index(accessor = structural_sensor_finding_kind,
          btree(columns = [sensor_kind])),
    index(accessor = structural_sensor_finding_target,
          btree(columns = [target_kind, target_id])),
)]
pub struct StructuralSensorFinding {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Short stable identifier for the sensor that produced this finding.
    /// Examples: `"orphan_detector"`, `"relational_integrity"`,
    /// `"schema_consistency"`, `"convention"`.
    pub sensor_kind: String,
    /// Short stable code identifying the rule that fired (e.g.
    /// `"page_no_parent"`, `"relation_dangling"`, `"property_type_mismatch"`).
    pub code: String,
    /// Target entity kind, e.g. `"page"`, `"property_value"`,
    /// `"property_definition"`, `"database_schema"`.
    pub target_kind: String,
    /// Primary key of the target entity (best-effort u64 coercion;
    /// strings are not used as targets today).
    pub target_id: u64,
    /// Human-readable summary of the finding, intended for the Inbox.
    pub message: String,
    /// Severity: `"info"`, `"warn"`, `"error"`. Sensor-defined.
    pub severity: String,
    /// JSON bag of additional context (e.g. expected vs. actual type).
    pub details_json: String,
    pub created_at: Timestamp,
    pub last_seen_at: Timestamp,
    /// Set when the finding has been acknowledged (manual dismiss or fixed).
    #[default(None::<Timestamp>)]
    pub resolved_at: Option<Timestamp>,
}

// ============================================================
// Structural Sensors
// ============================================================
//
// Computational structural sensors are cheap deterministic checks over the
// relational substrate. An Orcha worker invokes the corresponding `run_*`
// reducer on a schedule (cron-style; see `worker/src/structural-sensors.ts`)
// and the reducer (re-)writes findings into `structural_sensor_finding`.
//
// Each sensor follows the same upsert pattern: clear prior unresolved
// findings for that `sensor_kind`, then re-insert the current snapshot.
// This keeps the table size proportional to live findings, not to runs.

fn upsert_finding(
    ctx: &ReducerContext,
    sensor_kind: &str,
    code: &str,
    target_kind: &str,
    target_id: u64,
    severity: &str,
    message: String,
    details_json: String,
) {
    if !sensor_registry_contains(ctx, sensor_kind, code) {
        log::warn!(
            "upsert_finding: ({sensor_kind}, {code}) not in SensorRegistry; skipping"
        );
        return;
    }
    let existing = ctx
        .db
        .structural_sensor_finding()
        .iter()
        .find(|f| {
            f.sensor_kind == sensor_kind
                && f.code == code
                && f.target_kind == target_kind
                && f.target_id == target_id
                && f.resolved_at.is_none()
        });
    if let Some(prior) = existing {
        ctx.db
            .structural_sensor_finding()
            .id()
            .update(StructuralSensorFinding {
                last_seen_at: ctx.timestamp,
                message,
                severity: severity.to_string(),
                details_json,
                ..prior
            });
    } else {
        ctx.db
            .structural_sensor_finding()
            .insert(StructuralSensorFinding {
                id: next_structural_sensor_finding_id(ctx),
                sensor_kind: sensor_kind.to_string(),
                code: code.to_string(),
                target_kind: target_kind.to_string(),
                target_id,
                message,
                severity: severity.to_string(),
                details_json,
                created_at: ctx.timestamp,
                last_seen_at: ctx.timestamp,
                resolved_at: None,
            });
    }
}

/// Mark all live findings for `sensor_kind` whose `last_seen_at` is older
/// than this run as resolved (they didn't reproduce). Call once at the end
/// of every sensor run, with `run_started_at` captured before the upserts.
fn auto_resolve_stale_findings(
    ctx: &ReducerContext,
    sensor_kind: &str,
    run_started_at: Timestamp,
) {
    let stale: Vec<_> = ctx
        .db
        .structural_sensor_finding()
        .iter()
        .filter(|f| {
            f.sensor_kind == sensor_kind
                && f.resolved_at.is_none()
                && f.last_seen_at.to_micros_since_unix_epoch()
                    < run_started_at.to_micros_since_unix_epoch()
        })
        .collect();
    for f in stale {
        ctx.db
            .structural_sensor_finding()
            .id()
            .update(StructuralSensorFinding {
                resolved_at: Some(ctx.timestamp),
                ..f
            });
    }
}

/// Orphan detector: pages whose `parent_id` references a deleted or
/// missing parent. (Top-level pages with `parent_id = None` are not
/// orphans — they are roots.)
#[reducer]
pub fn run_orphan_detector(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("admin required to run orphan detector".to_string());
    }
    let run_started_at = ctx.timestamp;
    let kind = "orphan_detector";

    let live_page_ids: std::collections::HashSet<u64> = ctx
        .db
        .page()
        .iter()
        .filter(|p| p.deleted_at.is_none())
        .map(|p| p.id)
        .collect();

    for page in ctx.db.page().iter().filter(|p| p.deleted_at.is_none()) {
        if let Some(parent_id) = page.parent_id {
            if !live_page_ids.contains(&parent_id) {
                upsert_finding(
                    ctx,
                    kind,
                    "page_parent_missing",
                    "page",
                    page.id,
                    "warn",
                    format!(
                        "Page #{} ({}) references missing parent #{}",
                        page.id, page.title, parent_id
                    ),
                    format!(
                        "{{\"page_id\":{},\"parent_id\":{}}}",
                        page.id, parent_id
                    ),
                );
            }
        }
    }

    auto_resolve_stale_findings(ctx, kind, run_started_at);
    Ok(())
}

/// Relational integrity sensor: `PropertyValue::Relation(Vec<u64>)` entries
/// that point to deleted or missing pages.
#[reducer]
pub fn run_relational_integrity_sensor(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("admin required to run relational integrity sensor".to_string());
    }
    let run_started_at = ctx.timestamp;
    let kind = "relational_integrity";

    let live_page_ids: std::collections::HashSet<u64> = ctx
        .db
        .page()
        .iter()
        .filter(|p| p.deleted_at.is_none())
        .map(|p| p.id)
        .collect();

    for ppv in ctx.db.page_property_value().iter() {
        if let PropertyValue::Relation(targets) = &ppv.value {
            let dangling: Vec<u64> = targets
                .iter()
                .copied()
                .filter(|t| !live_page_ids.contains(t))
                .collect();
            if !dangling.is_empty() {
                upsert_finding(
                    ctx,
                    kind,
                    "relation_dangling",
                    "page_property_value",
                    ppv.id,
                    "warn",
                    format!(
                        "Relation on page #{} property #{} references {} missing page(s)",
                        ppv.page_id,
                        ppv.property_definition_id,
                        dangling.len()
                    ),
                    format!(
                        "{{\"page_id\":{},\"property_definition_id\":{},\"missing\":{:?}}}",
                        ppv.page_id, ppv.property_definition_id, dangling
                    ),
                );
            }
        }
    }

    auto_resolve_stale_findings(ctx, kind, run_started_at);
    Ok(())
}

/// Schema consistency sensor: `PagePropertyValue` rows whose `value` variant
/// does not match their `PropertyDefinition.property_type`. Catches stale
/// rows after a column type change.
#[reducer]
pub fn run_schema_consistency_sensor(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("admin required to run schema consistency sensor".to_string());
    }
    let run_started_at = ctx.timestamp;
    let kind = "schema_consistency";

    let defs: std::collections::HashMap<u64, PropertyType> = ctx
        .db
        .property_definition()
        .iter()
        .map(|d| (d.id, d.property_type))
        .collect();

    for ppv in ctx.db.page_property_value().iter() {
        let Some(expected) = defs.get(&ppv.property_definition_id) else {
            upsert_finding(
                ctx,
                kind,
                "property_definition_missing",
                "page_property_value",
                ppv.id,
                "error",
                format!(
                    "Property value #{} (page #{}) has no matching definition #{}",
                    ppv.id, ppv.page_id, ppv.property_definition_id
                ),
                format!(
                    "{{\"page_id\":{},\"property_definition_id\":{}}}",
                    ppv.page_id, ppv.property_definition_id
                ),
            );
            continue;
        };

        let actual_tag = match &ppv.value {
            PropertyValue::Text(_) => PropertyType::Text,
            PropertyValue::Number(_) => PropertyType::Number,
            PropertyValue::Date(_) => PropertyType::Date,
            PropertyValue::Select(_) => PropertyType::Select,
            PropertyValue::MultiSelect(_) => PropertyType::MultiSelect,
            PropertyValue::Relation(_) => PropertyType::Relation,
            PropertyValue::Checkbox(_) => PropertyType::Checkbox,
            PropertyValue::Url(_) => PropertyType::Url,
            PropertyValue::Person(_) => PropertyType::Person,
            PropertyValue::Ai(_) => PropertyType::Ai,
        };

        if &actual_tag != expected {
            upsert_finding(
                ctx,
                kind,
                "property_type_mismatch",
                "page_property_value",
                ppv.id,
                "warn",
                format!(
                    "Property value #{} (page #{}) is {:?} but definition #{} expects {:?}",
                    ppv.id, ppv.page_id, actual_tag, ppv.property_definition_id, expected
                ),
                format!(
                    "{{\"page_id\":{},\"property_definition_id\":{},\"actual\":\"{:?}\",\"expected\":\"{:?}\"}}",
                    ppv.page_id, ppv.property_definition_id, actual_tag, expected
                ),
            );
        }
    }

    auto_resolve_stale_findings(ctx, kind, run_started_at);
    Ok(())
}

/// Convention sensor: workspace-wide naming / structural conventions. Today
/// it flags property definitions with empty names and database schemas that
/// have zero columns. Operators can extend this to enforce custom conventions.
#[reducer]
pub fn run_convention_sensor(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("admin required to run convention sensor".to_string());
    }
    let run_started_at = ctx.timestamp;
    let kind = "convention";

    for def in ctx.db.property_definition().iter() {
        if def.name.trim().is_empty() {
            upsert_finding(
                ctx,
                kind,
                "property_definition_unnamed",
                "property_definition",
                def.id,
                "info",
                format!(
                    "Property definition #{} (schema #{}) has an empty name",
                    def.id, def.schema_id
                ),
                format!("{{\"schema_id\":{}}}", def.schema_id),
            );
        }
    }

    let mut counts: std::collections::HashMap<u64, u32> =
        std::collections::HashMap::new();
    for def in ctx.db.property_definition().iter() {
        *counts.entry(def.schema_id).or_insert(0) += 1;
    }
    for schema in ctx.db.database_schema().iter() {
        if counts.get(&schema.id).copied().unwrap_or(0) == 0 {
            upsert_finding(
                ctx,
                kind,
                "schema_no_columns",
                "database_schema",
                schema.id,
                "info",
                format!(
                    "Database schema #{} ({}) has zero columns",
                    schema.id, schema.name
                ),
                format!("{{\"page_id\":{}}}", schema.page_id),
            );
        }
    }

    auto_resolve_stale_findings(ctx, kind, run_started_at);
    Ok(())
}

/// Refine-permissions sensor (steering loop). Mines the private
/// `tool_call_audit_log` for `outcome = "denied"` entries, groups by
/// `(agent_id, tool_name)`, and emits one finding per group. Surfaces
/// in the same Inbox feed so operators can grant the missing permission
/// (or confirm the denial was correct) without poking at the audit log
/// directly.
#[reducer]
pub fn run_denied_tool_calls_sensor(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("admin required to run denied tool calls sensor".to_string());
    }
    let run_started_at = ctx.timestamp;
    let kind = "denied_tool_calls";

    let mut counts: std::collections::HashMap<(String, String), (u64, Timestamp)> =
        std::collections::HashMap::new();
    for entry in ctx.db.tool_call_audit_log().iter() {
        if entry.outcome != "denied" {
            continue;
        }
        let key = (entry.agent_id.clone(), entry.tool_name.clone());
        let slot = counts
            .entry(key)
            .or_insert((0u64, entry.called_at));
        slot.0 += 1;
        if entry.called_at.to_micros_since_unix_epoch()
            > slot.1.to_micros_since_unix_epoch()
        {
            slot.1 = entry.called_at;
        }
    }

    for ((agent_id, tool_name), (count, last_at)) in counts {
        let target_id_hash = stable_hash_pair(&agent_id, &tool_name);
        upsert_finding(
            ctx,
            kind,
            "tool_denied",
            "agent_tool",
            target_id_hash,
            "info",
            format!(
                "Agent `{}` was denied `{}` {} time(s) (last at {})",
                agent_id,
                tool_name,
                count,
                last_at.to_micros_since_unix_epoch(),
            ),
            format!(
                "{{\"agent_id\":{:?},\"tool_name\":{:?},\"count\":{}}}",
                agent_id, tool_name, count
            ),
        );
    }

    auto_resolve_stale_findings(ctx, kind, run_started_at);
    Ok(())
}

fn stable_hash_pair(a: &str, b: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    a.hash(&mut h);
    b.hash(&mut h);
    h.finish()
}

/// Manually mark a finding as resolved (e.g. when the user fixes the
/// underlying issue and wants to clear the inbox entry).
#[reducer]
pub fn resolve_structural_finding(ctx: &ReducerContext, finding_id: u64) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("admin required to resolve structural finding".to_string());
    }
    let f = ctx
        .db
        .structural_sensor_finding()
        .id()
        .find(finding_id)
        .ok_or("Finding not found")?;
    ctx.db
        .structural_sensor_finding()
        .id()
        .update(StructuralSensorFinding {
            resolved_at: Some(ctx.timestamp),
            ..f
        });
    Ok(())
}

/// Idempotent seed for `SensorRegistry`. Safe to call repeatedly — every
/// (sensor_kind, code) pair is upserted only if missing. Add new rows here
/// when shipping a new sensor; the corresponding `run_*` reducer will then
/// be allowed to emit findings with that code.
#[reducer]
pub fn seed_sensor_registry(ctx: &ReducerContext) -> Result<(), String> {
    seed_sensor_registry_inner(ctx);
    Ok(())
}

pub(crate) fn seed_sensor_registry_inner(ctx: &ReducerContext) {
    // (sensor_kind, code, display_name, description, default_severity)
    const ROWS: &[(&str, &str, &str, &str, &str)] = &[
        (
            "orphan_detector",
            "page_parent_missing",
            "Orphaned page",
            "A page references a parent that no longer exists (deleted or never created).",
            "warn",
        ),
        (
            "relational_integrity",
            "relation_dangling",
            "Dangling relation",
            "A relation property points at one or more pages that no longer exist.",
            "warn",
        ),
        (
            "schema_consistency",
            "property_definition_missing",
            "Missing property definition",
            "A property value row references a property definition that no longer exists.",
            "error",
        ),
        (
            "schema_consistency",
            "property_type_mismatch",
            "Property value type mismatch",
            "A property value's variant does not match its definition's declared type.",
            "warn",
        ),
        (
            "convention",
            "property_definition_unnamed",
            "Unnamed property definition",
            "A column was created without a name. The UI will display it as a placeholder.",
            "info",
        ),
        (
            "convention",
            "schema_no_columns",
            "Empty database schema",
            "A database schema has zero columns and cannot store any property values.",
            "info",
        ),
        (
            "denied_tool_calls",
            "tool_denied",
            "Repeatedly denied tool call",
            "An agent is being denied access to a tool. Either grant the permission or confirm the deny is correct.",
            "info",
        ),
    ];

    for (kind, code, display, desc, sev) in ROWS {
        let exists = ctx
            .db
            .sensor_registry()
            .iter()
            .any(|r| r.sensor_kind == *kind && r.code == *code);
        if exists {
            continue;
        }
        ctx.db.sensor_registry().insert(SensorRegistry {
            id: next_sensor_registry_id(ctx),
            sensor_kind: kind.to_string(),
            code: code.to_string(),
            display_name: display.to_string(),
            description: desc.to_string(),
            default_severity: sev.to_string(),
        });
    }
}

fn sensor_registry_contains(ctx: &ReducerContext, sensor_kind: &str, code: &str) -> bool {
    ctx.db
        .sensor_registry()
        .iter()
        .any(|r| r.sensor_kind == sensor_kind && r.code == code)
}
