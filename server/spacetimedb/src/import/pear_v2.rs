//! Chunked import of `pear-snapshot-v2` produced by the web client's
//! `buildPearSnapshotV2` (see `snapshot_tables_v2.json` for the canonical
//! table policy this module implements the import side of).
//!
//! Unlike v1's single-reducer JSON blob, v2 streams the snapshot in chunks so
//! large workspaces fit within reducer argument limits:
//!
//! 1. [`import_v2_begin`] — guards (empty db, authenticated caller, no live
//!    session), verifies the header format, creates the session lock.
//! 2. [`import_v2_chunk`] × N — one JSON array of rows per call, strictly
//!    sequenced (`seq == last_seq + 1`), dispatched per table.
//! 3. [`import_v2_commit`] — verifies per-table applied+skipped counts against
//!    the export manifest, resets the `id_counter` table, releases the session.
//!
//! Each chunk is its own transaction; an interrupted import leaves partial
//! rows behind. [`import_v2_abort`] releases the session lock only — recovery
//! from a partial import is `spacetime publish --clear-database` and re-run.

use super::decode::*;
use crate::auth::sender_is_admin;
use crate::bridge::{bridge_device_grant, BridgeDeviceGrant, UnlistedCommandPolicy};
use crate::conversations::{message_feedback, MessageFeedback, MessageFeedbackRating};
use crate::{
    ai_evaluation, ai_user_config, ai_user_memory, ai_user_profile, ai_user_routine, api_call_log,
    api_endpoint, api_endpoint_key, api_field_mapping, attachment, auto_apply_binding,
    automation_action, automation_capability, automation_condition, automation_event_queue,
    automation_rule, automation_run_log, block_access_rule, bridge_command, bridge_command_result,
    bridge_device_allowlist, bridge_device_summary, component_node, component_type_definition,
    component_yjs_state, conversation, conversation_attachment, conversation_message,
    conversation_participant, database_row_marker, database_schema, database_view,
    extension_manifest, harness_template, id_counter, installed_extension, orcha_agent, orcha_job,
    orcha_shared_context, orcha_task, orcha_usage_event, page, page_access_request,
    page_access_rule, page_content, page_property_value, page_property_value_history,
    page_snapshot, page_yjs_state, property_definition, review_agent_binding, review_annotation,
    structural_sensor_finding, user, user_preference, workspace_setting,
};
use crate::{
    AccessRequestStatus, AiEvaluation, AiPrimitive, AiUserConfig, AiUserProfile, AiUserRole,
    AiUserRoutine, ApiCallLog, AttachmentKind, AutomationAction, AutomationActionKind,
    RoutineScheduleKind,
    AutomationCapability, AutomationCapabilityKind, AutomationCondition, AutomationConditionKind,
    AutomationEventQueue, AutomationEventStatus, AutomationMode, AutomationRule, AutomationRunLog,
    AutomationScheduleKind, AutomationTriggerKind, BridgeCommand, BridgeCommandResult,
    BridgeCommandStatus, BridgeDeviceAllowlist, BridgeDeviceSummary, ComponentCapability,
    ComponentNode, ComponentTypeDefinition, ComponentYjsState, Conversation,
    ConversationAttachment, ConversationKind, ConversationVisibility, DatabaseRowMarker,
    ExtensionManifest, ExtensionType, HarnessTemplateSource, InferenceProvider, OrchaJob,
    OrchaTask, OrchaUsageEvent, Page, PageAccessRequest, PageContentFormat,
    StructuralSensorFinding,
};
use serde_json::Value;
use spacetimedb::{
    reducer, table, Identity, ReducerContext, ScheduleAt, Table, TimeDuration, Timestamp,
};
use std::collections::HashSet;

/// Keep in sync with `PEAR_SNAPSHOT_V2_FORMAT` in `pear/web/src/lib/pearExport.ts`
/// and the `format` field of `snapshot_tables_v2.json`.
const FORMAT: &str = "pear-snapshot-v2";

/// The fixed primary key of the single [`ImportSession`] row — at most one
/// import session may exist at a time.
const IMPORT_SESSION_ID: u64 = 1;

/// Every table this importer can dispatch. MUST match the `include` list of
/// `snapshot_tables_v2.json` exactly — enforced by
/// `dispatch_table_matches_policy_include_list` below (and mirrored on the
/// TypeScript side in `pear/web/src/lib/pearExport.test.ts`).
const IMPORT_V2_TABLES: &[&str] = &[
    "user",
    "user_preference",
    "workspace_setting",
    "page",
    "page_content",
    "page_yjs_state",
    "page_snapshot",
    "component_node",
    "component_yjs_state",
    "component_type_definition",
    "database_schema",
    "property_definition",
    "database_view",
    "page_property_value",
    "page_property_value_history",
    "database_row_marker",
    "attachment",
    "conversation_attachment",
    "page_access_rule",
    "block_access_rule",
    "page_access_request",
    "ai_user_profile",
    "ai_user_memory",
    "ai_user_routine",
    "ai_evaluation",
    "conversation",
    "conversation_participant",
    "conversation_message",
    "message_feedback",
    "harness_template",
    "review_agent_binding",
    "review_annotation",
    "auto_apply_binding",
    "extension_manifest",
    "installed_extension",
    "orcha_agent",
    "orcha_job",
    "orcha_task",
    "orcha_shared_context",
    "orcha_usage_event",
    "api_endpoint",
    "api_field_mapping",
    "api_endpoint_key",
    "api_call_log",
    "automation_rule",
    "automation_action",
    "automation_condition",
    "automation_capability",
    "automation_event_queue",
    "automation_run_log",
    "bridge_command",
    "bridge_command_result",
    "bridge_device_allowlist",
    "bridge_device_grant",
    "bridge_device_summary",
    "structural_sensor_finding",
];

// ── Session tables (private) ──────────────────────────────────────────────────

/// The single in-flight import session. Private — session state is importer
/// plumbing, never client data. `id` is always [`IMPORT_SESSION_ID`].
#[table(accessor = import_session)]
pub struct ImportSession {
    #[primary_key]
    pub id: u64,
    /// The authenticated user who called `import_v2_begin`; the only identity
    /// allowed to send chunks / commit (any admin may also abort).
    pub created_by: Identity,
    pub started_at: Timestamp,
    /// Sequence number of the last accepted chunk (0 before the first chunk).
    pub last_seq: u32,
}

/// Per-table applied/skipped row counts, accumulated across chunk
/// transactions and reconciled against the export manifest at commit time.
/// Private — see [`ImportSession`].
#[table(accessor = import_session_count)]
pub struct ImportSessionCount {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub table_name: String,
    /// Rows inserted into the table.
    pub applied: u64,
    /// Rows intentionally dropped by an import row guard (builtin harness
    /// templates / extension manifests / component types, and installed
    /// extensions pointing at seeded builtin manifests).
    pub skipped: u64,
}

// ── Reducers ──────────────────────────────────────────────────────────────────

/// Open a `pear-snapshot-v2` import session. Only succeeds when the database
/// has **no pages** (empty workspace), the caller is an authenticated user,
/// and no other session is in flight. `header_json` carries
/// `{"format":"pear-snapshot-v2"}` from the export header.
#[reducer]
pub fn import_v2_begin(ctx: &ReducerContext, header_json: String) -> Result<(), String> {
    if ctx.db.page().iter().next().is_some() {
        return Err(
            "Import refused: database already has pages. Use an empty database (new module DB)."
                .to_string(),
        );
    }

    let me = ctx.sender();
    let ok = ctx
        .db
        .user()
        .identity()
        .find(me)
        .map(|u| u.is_authenticated)
        .unwrap_or(false);
    if !ok {
        return Err("You must be logged in to import a snapshot.".to_string());
    }

    if ctx
        .db
        .import_session()
        .id()
        .find(IMPORT_SESSION_ID)
        .is_some()
    {
        return Err(
            "Import refused: an import session is already in progress. Abort it first \
             (import_v2_abort)."
                .to_string(),
        );
    }

    let root: Value = serde_json::from_str(&header_json).map_err(|e| format!("JSON parse: {e}"))?;
    let format = root
        .get("format")
        .and_then(|v| v.as_str())
        .ok_or("missing format")?;
    if format != FORMAT {
        return Err(format!("unsupported format: {format}"));
    }

    ctx.db.import_session().insert(ImportSession {
        id: IMPORT_SESSION_ID,
        created_by: me,
        started_at: ctx.timestamp,
        last_seq: 0,
    });
    Ok(())
}

/// Apply one chunk of snapshot rows. `rows_json` is a JSON array of rows in
/// the same camelCase `__pear`-tagged encoding v1 uses. Chunks are strictly
/// sequenced: `seq` must be `last_seq + 1`. Only the session creator may call.
#[reducer]
pub fn import_v2_chunk(
    ctx: &ReducerContext,
    seq: u32,
    table_name: String,
    rows_json: String,
) -> Result<(), String> {
    let session = ctx
        .db
        .import_session()
        .id()
        .find(IMPORT_SESSION_ID)
        .ok_or("No import session in progress — call import_v2_begin first.")?;
    if ctx.sender() != session.created_by {
        return Err("Only the import session creator may send chunks.".to_string());
    }
    let expected = session.last_seq + 1;
    if seq != expected {
        return Err(format!(
            "chunk out of order: expected seq {expected}, got {seq}"
        ));
    }

    // Drift guard: refuse tables the policy doesn't include, so an export
    // built against a newer schema fails loudly instead of dropping rows.
    if !IMPORT_V2_TABLES.contains(&table_name.as_str()) {
        return Err(format!(
            "unknown snapshot table: {table_name} (not in the pear-snapshot-v2 include list)"
        ));
    }

    let rows: Value = serde_json::from_str(&rows_json).map_err(|e| format!("JSON parse: {e}"))?;
    let arr = rows.as_array().ok_or("rows_json: expected array")?;

    let (applied, skipped) = import_rows(ctx, &table_name, arr)?;
    record_counts(ctx, &table_name, applied, skipped);

    ctx.db.import_session().id().update(ImportSession {
        last_seq: seq,
        ..session
    });
    Ok(())
}

/// Finish an import session. `manifest_json` is `{"counts": {table: n}}` from
/// the export; every entry must satisfy `applied + skipped == n` or the whole
/// commit is refused (the session stays open so the caller can inspect/abort).
///
/// On success, deletes **all** `id_counter` rows: the next allocation re-seeds
/// each counter from the post-import `max(id)` of its table (the documented
/// reset path in `id_counters.rs`). This is what fixes the latent
/// seed-collision bug — counters seeded on the empty pre-import database
/// would otherwise hand out ids that collide with imported rows.
#[reducer]
pub fn import_v2_commit(ctx: &ReducerContext, manifest_json: String) -> Result<(), String> {
    let session = ctx
        .db
        .import_session()
        .id()
        .find(IMPORT_SESSION_ID)
        .ok_or("No import session in progress — call import_v2_begin first.")?;
    if ctx.sender() != session.created_by {
        return Err("Only the import session creator may commit.".to_string());
    }

    let root: Value =
        serde_json::from_str(&manifest_json).map_err(|e| format!("JSON parse: {e}"))?;
    let counts = root
        .get("counts")
        .and_then(|v| v.as_object())
        .ok_or("missing counts")?;

    let mut mismatches: Vec<String> = Vec::new();
    for (name, expected) in counts {
        let expected = decode_u64(expected).map_err(|e| format!("counts.{name}: {e}"))?;
        let (applied, skipped) = counts_for(ctx, name);
        if applied + skipped != expected {
            mismatches.push(format!(
                "{name}: manifest {expected}, applied {applied} + skipped {skipped}"
            ));
        }
    }
    if !mismatches.is_empty() {
        return Err(format!(
            "Import count mismatch — commit refused (session left open): {}",
            mismatches.join("; ")
        ));
    }

    // Reset the id allocator (see doc comment above / id_counters.rs).
    let counter_names: Vec<String> = ctx.db.id_counter().iter().map(|r| r.name).collect();
    for name in counter_names {
        ctx.db.id_counter().name().delete(name);
    }

    clear_session(ctx);
    Ok(())
}

/// Abort an in-flight import session. The creator or any workspace admin may
/// call this. Only the session lock and counters are removed — **rows already
/// imported by earlier chunks remain** (chunks are separate transactions).
/// Recovery from a partial import is `spacetime publish --clear-database`
/// and a fresh import.
#[reducer]
pub fn import_v2_abort(ctx: &ReducerContext) -> Result<(), String> {
    let session = ctx
        .db
        .import_session()
        .id()
        .find(IMPORT_SESSION_ID)
        .ok_or("No import session in progress.")?;
    if ctx.sender() != session.created_by && !sender_is_admin(ctx) {
        return Err(
            "Only the import session creator or a workspace admin may abort.".to_string(),
        );
    }
    clear_session(ctx);
    Ok(())
}

// ── Session helpers ───────────────────────────────────────────────────────────

fn clear_session(ctx: &ReducerContext) {
    ctx.db.import_session().id().delete(IMPORT_SESSION_ID);
    let count_ids: Vec<u64> = ctx.db.import_session_count().iter().map(|c| c.id).collect();
    for id in count_ids {
        ctx.db.import_session_count().id().delete(id);
    }
}

fn record_counts(ctx: &ReducerContext, table_name: &str, applied: u64, skipped: u64) {
    let existing = ctx
        .db
        .import_session_count()
        .iter()
        .find(|c| c.table_name == table_name);
    match existing {
        Some(c) => {
            let applied = c.applied + applied;
            let skipped = c.skipped + skipped;
            ctx.db.import_session_count().id().update(ImportSessionCount {
                applied,
                skipped,
                ..c
            });
        }
        None => {
            ctx.db.import_session_count().insert(ImportSessionCount {
                id: 0,
                table_name: table_name.to_string(),
                applied,
                skipped,
            });
        }
    }
}

fn counts_for(ctx: &ReducerContext, table_name: &str) -> (u64, u64) {
    ctx.db
        .import_session_count()
        .iter()
        .find(|c| c.table_name == table_name)
        .map(|c| (c.applied, c.skipped))
        .unwrap_or((0, 0))
}

// ── Per-table dispatch ────────────────────────────────────────────────────────

/// Decode + insert every row of one chunk. Returns `(applied, skipped)`;
/// guard-skipped rows count as skipped, never as applied.
fn import_rows(ctx: &ReducerContext, table_name: &str, arr: &[Value]) -> Result<(u64, u64), String> {
    // Plain arm: decode each row and insert it; nothing is ever skipped.
    macro_rules! plain {
        ($accessor:ident, $decode:path) => {{
            let mut applied = 0u64;
            for row in arr {
                ctx.db.$accessor().insert($decode(row)?);
                applied += 1;
            }
            (applied, 0u64)
        }};
    }

    let counts: (u64, u64) = match table_name {
        "user" => plain!(user, decode_user),
        "user_preference" => plain!(user_preference, decode_user_preference),
        "workspace_setting" => plain!(workspace_setting, decode_workspace_setting),
        "page" => plain!(page, decode_page),
        "page_content" => plain!(page_content, decode_page_content),
        "page_yjs_state" => plain!(page_yjs_state, decode_page_yjs_state),
        "page_snapshot" => plain!(page_snapshot, decode_page_snapshot),
        "component_node" => plain!(component_node, decode_component_node),
        "component_yjs_state" => plain!(component_yjs_state, decode_component_yjs_state),
        "component_type_definition" => {
            // Guard: builtin component types are re-seeded by init;
            // `component_node` references types by string, so id drift on the
            // seeded rows is harmless.
            let mut applied = 0u64;
            let mut skipped = 0u64;
            for row in arr {
                let def = decode_component_type_definition(row)?;
                if def.is_builtin {
                    skipped += 1;
                    continue;
                }
                ctx.db.component_type_definition().insert(def);
                applied += 1;
            }
            (applied, skipped)
        }
        "database_schema" => plain!(database_schema, decode_database_schema),
        "property_definition" => plain!(property_definition, decode_property_definition),
        "database_view" => plain!(database_view, decode_database_view),
        "page_property_value" => plain!(page_property_value, decode_page_property_value),
        "page_property_value_history" => {
            plain!(page_property_value_history, decode_page_property_value_history)
        }
        "database_row_marker" => plain!(database_row_marker, decode_database_row_marker),
        "attachment" => plain!(attachment, decode_attachment),
        "conversation_attachment" => {
            plain!(conversation_attachment, decode_conversation_attachment)
        }
        "page_access_rule" => plain!(page_access_rule, decode_page_access_rule),
        "block_access_rule" => plain!(block_access_rule, decode_block_access_rule),
        "page_access_request" => plain!(page_access_request, decode_page_access_request),
        "ai_user_profile" => {
            // Restore AI users with stub AiUserConfig (no api_key) so FKs
            // resolve — same behavior as v1 and as documented in the
            // `ai_user_config` exclusion of snapshot_tables_v2.json.
            // Operators reconfigure provider/model/key post-restore.
            let mut applied = 0u64;
            for row in arr {
                let p: AiUserProfile = decode_ai_user_profile(row)?;
                let id = p.ai_user_id;
                if ctx.db.ai_user_config().id().find(id).is_none() {
                    ctx.db.ai_user_config().insert(AiUserConfig {
                        id,
                        identity: p.identity,
                        created_by: ctx.sender(),
                        provider: InferenceProvider::Anthropic,
                        model: p.model_name.clone(),
                        endpoint: None,
                        api_key: None,
                        system_prompt: None,
                        max_tokens: 8192,
                        created_at: ctx.timestamp,
                        updated_at: ctx.timestamp,
                        monthly_token_cap: None,
                        role: AiUserRole::Standard,
                        harness_template_id: None,
                        allow_evaluation_sharing: false,
                        tool_secrets_json: None,
                        worker_token: None,
                    });
                }
                ctx.db.ai_user_profile().insert(p);
                applied += 1;
            }
            (applied, 0)
        }
        "ai_user_memory" => plain!(ai_user_memory, decode_ai_user_memory),
        "ai_user_routine" => plain!(ai_user_routine, decode_ai_user_routine),
        "ai_evaluation" => plain!(ai_evaluation, decode_ai_evaluation),
        "conversation" => plain!(conversation, decode_conversation),
        "conversation_participant" => {
            plain!(conversation_participant, decode_conversation_participant)
        }
        "conversation_message" => plain!(conversation_message, decode_conversation_message),
        "message_feedback" => plain!(message_feedback, decode_message_feedback),
        "harness_template" => {
            // Guard: builtin templates are re-seeded by init and would trip
            // the unique `external_id` constraint. Workspace-authored
            // templates are preserved verbatim.
            let mut applied = 0u64;
            let mut skipped = 0u64;
            for row in arr {
                let t = decode_harness_template(row)?;
                if matches!(t.source, HarnessTemplateSource::Builtin) {
                    skipped += 1;
                    continue;
                }
                ctx.db.harness_template().insert(t);
                applied += 1;
            }
            (applied, skipped)
        }
        "review_agent_binding" => plain!(review_agent_binding, decode_review_agent_binding),
        "review_annotation" => plain!(review_annotation, decode_review_annotation),
        "auto_apply_binding" => plain!(auto_apply_binding, decode_auto_apply_binding),
        "extension_manifest" => {
            // Guard: builtin manifests are seeded by
            // `seed_builtin_extensions_inner` at init; their ids collide with
            // the counter-allocated seeds.
            let mut applied = 0u64;
            let mut skipped = 0u64;
            for row in arr {
                let mfst = decode_extension_manifest(row)?;
                if matches!(mfst.extension_type, ExtensionType::Builtin) {
                    skipped += 1;
                    continue;
                }
                ctx.db.extension_manifest().insert(mfst);
                applied += 1;
            }
            (applied, skipped)
        }
        "installed_extension" => {
            // Guard: the builtin-extension seed creates its own installed row
            // per builtin manifest, so a snapshot row whose `manifest_id`
            // collides with a builtin manifest ALREADY IN THIS DB (seeded at
            // init) is skipped. Chunk order isn't guaranteed, so this is
            // commit-time-free reconciliation against the seed, not against
            // the snapshot's own (skipped) builtin manifests. Residual edge:
            // a snapshot row referencing a builtin manifest id that does NOT
            // match any seeded id here imports verbatim and dangles — a
            // harmless lookup miss, counted as applied.
            let builtin_manifest_ids: HashSet<u64> = ctx
                .db
                .extension_manifest()
                .iter()
                .filter(|m| matches!(m.extension_type, ExtensionType::Builtin))
                .map(|m| m.id)
                .collect();
            let mut applied = 0u64;
            let mut skipped = 0u64;
            for row in arr {
                let ie = decode_installed_extension(row)?;
                if builtin_manifest_ids.contains(&ie.manifest_id) {
                    skipped += 1;
                    continue;
                }
                ctx.db.installed_extension().insert(ie);
                applied += 1;
            }
            (applied, skipped)
        }
        "orcha_agent" => plain!(orcha_agent, decode_orcha_agent),
        "orcha_job" => plain!(orcha_job, decode_orcha_job),
        "orcha_task" => plain!(orcha_task, decode_orcha_task),
        "orcha_shared_context" => plain!(orcha_shared_context, decode_orcha_shared_context),
        "orcha_usage_event" => plain!(orcha_usage_event, decode_orcha_usage_event),
        "api_endpoint" => plain!(api_endpoint, decode_api_endpoint),
        "api_field_mapping" => plain!(api_field_mapping, decode_api_field_mapping),
        "api_endpoint_key" => plain!(api_endpoint_key, decode_api_endpoint_key),
        "api_call_log" => plain!(api_call_log, decode_api_call_log),
        "automation_rule" => plain!(automation_rule, decode_automation_rule),
        "automation_action" => plain!(automation_action, decode_automation_action),
        "automation_condition" => plain!(automation_condition, decode_automation_condition),
        "automation_capability" => plain!(automation_capability, decode_automation_capability),
        "automation_event_queue" => plain!(automation_event_queue, decode_automation_event_queue),
        "automation_run_log" => plain!(automation_run_log, decode_automation_run_log),
        "bridge_command" => plain!(bridge_command, decode_bridge_command),
        "bridge_command_result" => plain!(bridge_command_result, decode_bridge_command_result),
        "bridge_device_allowlist" => {
            plain!(bridge_device_allowlist, decode_bridge_device_allowlist)
        }
        "bridge_device_grant" => plain!(bridge_device_grant, decode_bridge_device_grant),
        "bridge_device_summary" => plain!(bridge_device_summary, decode_bridge_device_summary),
        "structural_sensor_finding" => {
            plain!(structural_sensor_finding, decode_structural_sensor_finding)
        }
        other => {
            return Err(format!(
                "unknown snapshot table: {other} (not in the pear-snapshot-v2 include list)"
            ))
        }
    };
    Ok(counts)
}

// ── v2 helpers ────────────────────────────────────────────────────────────────

fn string_vec_at(m: &serde_json::Map<String, Value>, key: &str) -> Result<Vec<String>, String> {
    let arr = m
        .get(key)
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("missing array {key}"))?;
    arr.iter()
        .map(|x| {
            x.as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| format!("{key}: expected string"))
        })
        .collect()
}

fn opt_identity_at(
    m: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<Identity>, String> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(decode_identity(v)?)),
    }
}

/// Decode an identity that carries `#[default(Identity::ZERO)]` on the struct:
/// absent/null falls back to `Identity::ZERO`, exactly like the column default.
fn identity_at_or_zero(m: &serde_json::Map<String, Value>, key: &str) -> Result<Identity, String> {
    Ok(opt_identity_at(m, key)?.unwrap_or(Identity::ZERO))
}

fn opt_i32_at(m: &serde_json::Map<String, Value>, key: &str) -> Result<Option<i32>, String> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(decode_i64(v)? as i32)),
    }
}

// ── v2 decoders for tables that changed since v1 ─────────────────────────────

fn decode_page_content_format(v: &Value) -> Result<PageContentFormat, String> {
    decode_enum_tag2(
        v,
        &[
            ("BlockNote", PageContentFormat::BlockNote),
            ("ComponentTree", PageContentFormat::ComponentTree),
        ],
        "PageContentFormat",
    )
}

fn decode_page(v: &Value) -> Result<Page, String> {
    let m = obj(v, "page")?;
    let parent_id = opt_u64_at(m, "parentId")?;
    Ok(Page {
        id: u64_at(m, "id")?,
        parent_id,
        page_type: decode_page_type(m.get("pageType").ok_or("pageType")?)?,
        title: string_at(m, "title")?,
        sort_order: u64_at(m, "sortOrder")? as u32,
        embedding: decode_opt_f32_vec(m.get("embedding"))?,
        created_by: decode_actor_type(m.get("createdBy").ok_or("createdBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
        deleted_at: opt_timestamp_at(m, "deletedAt")?,
        icon: opt_string_at(m, "icon")?,
        parent_pk: parent_id.unwrap_or(0),
        is_hidden: bool_at_or(m, "isHidden", false),
        // v2 round-trips the content format; absent (older exporter build)
        // falls back to BlockNote, matching the column default.
        content_format: match m.get("contentFormat") {
            None | Some(Value::Null) => PageContentFormat::BlockNote,
            Some(v) => decode_page_content_format(v)?,
        },
    })
}

fn decode_conversation_visibility(v: &Value) -> Result<ConversationVisibility, String> {
    decode_enum_tag2(
        v,
        &[
            ("Private", ConversationVisibility::Private),
            ("Participants", ConversationVisibility::Participants),
            ("PageInheriting", ConversationVisibility::PageInheriting),
        ],
        "ConversationVisibility",
    )
}

fn decode_conversation_kind(v: &Value) -> Result<ConversationKind, String> {
    decode_enum_tag2(
        v,
        &[
            ("ContextThread", ConversationKind::ContextThread),
            ("Dm", ConversationKind::Dm),
            ("AiDm", ConversationKind::AiDm),
            ("GroupDm", ConversationKind::GroupDm),
            ("SharedThread", ConversationKind::SharedThread),
        ],
        "ConversationKind",
    )
}

fn decode_conversation(v: &Value) -> Result<Conversation, String> {
    let m = obj(v, "conversation")?;
    Ok(Conversation {
        id: u64_at(m, "id")?,
        page_id: opt_u64_at(m, "pageId")?,
        initiated_by: decode_identity(m.get("initiatedBy").ok_or("initiatedBy")?)?,
        status: decode_conversation_status(m.get("status").ok_or("status")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
        // visibility/kind carry `#[default(...)]` on the struct; fall back to
        // the same defaults when a row predates the column.
        visibility: match m.get("visibility") {
            None | Some(Value::Null) => ConversationVisibility::Private,
            Some(v) => decode_conversation_visibility(v)?,
        },
        kind: match m.get("kind") {
            None | Some(Value::Null) => ConversationKind::ContextThread,
            Some(v) => decode_conversation_kind(v)?,
        },
        canonical_key: opt_string_at(m, "canonicalKey")?,
        block_anchor: opt_u64_at(m, "blockAnchor")?,
        model_override: opt_string_at(m, "modelOverride")?,
        effort_override: opt_string_at(m, "effortOverride")?,
        // Resolution attribution is not carried across an import: the
        // resolving identity belongs to the source workspace and would not
        // resolve here. Imported threads keep their status but lose "who".
        resolved_by: None,
        resolved_at: None,
    })
}

fn decode_orcha_job(v: &Value) -> Result<OrchaJob, String> {
    let m = obj(v, "orcha_job")?;
    Ok(OrchaJob {
        id: u64_at(m, "id")?,
        user_id: string_at(m, "userId")?,
        ai_user_id: opt_u64_at(m, "aiUserId")?,
        prompt: string_at(m, "prompt")?,
        page_id: opt_u64_at(m, "pageId")?,
        status: string_at(m, "status")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        tier: opt_string_at(m, "tier")?,
        nonce: opt_string_at(m, "nonce")?,
        parent_job_id: opt_u64_at(m, "parentJobId")?,
        spawn_depth: u64_at(m, "spawnDepth").unwrap_or(0) as u32,
        // v2 round-trips the spawning principal; absent falls back to the
        // column default (Identity::ZERO).
        spawning_principal: identity_at_or_zero(m, "spawningPrincipal")?,
    })
}

fn decode_orcha_task(v: &Value) -> Result<OrchaTask, String> {
    let m = obj(v, "orcha_task")?;
    let deps = m
        .get("dependsOn")
        .and_then(|v| v.as_array())
        .ok_or("dependsOn")?;
    let depends_on: Vec<u64> = deps.iter().map(decode_u64).collect::<Result<_, _>>()?;
    Ok(OrchaTask {
        id: u64_at(m, "id")?,
        job_id: u64_at(m, "jobId")?,
        description: string_at(m, "description")?,
        task_type: string_at(m, "taskType")?,
        status: string_at(m, "status")?,
        depends_on,
        required_capabilities: string_vec_at(m, "requiredCapabilities")?,
        assigned_to: opt_string_at(m, "assignedTo")?,
        result: opt_string_at(m, "result")?,
        // v2 round-trips the claim lease when present.
        claimed_at: opt_timestamp_at(m, "claimedAt")?,
    })
}

fn decode_extension_type(v: &Value) -> Result<ExtensionType, String> {
    decode_enum_tag2(
        v,
        &[
            ("ConfigBundle", ExtensionType::ConfigBundle),
            ("McpServer", ExtensionType::McpServer),
            ("Hybrid", ExtensionType::Hybrid),
            // v2 accepts Builtin so the manifest guard can classify and skip
            // it (v1 predates the variant and rejects it outright).
            ("Builtin", ExtensionType::Builtin),
        ],
        "ExtensionType",
    )
}

fn decode_extension_manifest(v: &Value) -> Result<ExtensionManifest, String> {
    let m = obj(v, "extension_manifest")?;
    Ok(ExtensionManifest {
        id: u64_at(m, "id")?,
        name: string_at(m, "name")?,
        description: string_at(m, "description")?,
        extension_type: decode_extension_type(m.get("extensionType").ok_or("extensionType")?)?,
        version: string_at(m, "version")?,
        author_identity: opt_identity_at(m, "authorIdentity")?,
        manifest_json: string_at(m, "manifestJson")?,
        source_url: opt_string_at(m, "sourceUrl")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
    })
}

// ── Decoders for tables new in v2 ─────────────────────────────────────────────

fn decode_component_node(v: &Value) -> Result<ComponentNode, String> {
    let m = obj(v, "component_node")?;
    Ok(ComponentNode {
        id: u64_at(m, "id")?,
        surface_id: u64_at(m, "surfaceId")?,
        parent_id: opt_u64_at(m, "parentId")?,
        component_type: string_at(m, "componentType")?,
        props: string_at(m, "props")?,
        order: u64_at(m, "order")? as u32,
        created_by: decode_actor_type(m.get("createdBy").ok_or("createdBy")?)?,
        updated_by: decode_actor_type(m.get("updatedBy").ok_or("updatedBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
        deleted_at: opt_timestamp_at(m, "deletedAt")?,
    })
}

fn decode_component_yjs_state(v: &Value) -> Result<ComponentYjsState, String> {
    let m = obj(v, "component_yjs_state")?;
    Ok(ComponentYjsState {
        component_node_id: u64_at(m, "componentNodeId")?,
        data: decode_bytes(m.get("data").ok_or("data")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

fn decode_component_capability(v: &Value) -> Result<ComponentCapability, String> {
    decode_enum_tag2(
        v,
        &[
            ("ReadsDatabase", ComponentCapability::ReadsDatabase),
            ("ReadsProperty", ComponentCapability::ReadsProperty),
            ("WritesDatabase", ComponentCapability::WritesDatabase),
            ("WritesProperty", ComponentCapability::WritesProperty),
            ("DeletesRow", ComponentCapability::DeletesRow),
            ("NavigatesToPage", ComponentCapability::NavigatesToPage),
            ("OpensExternalUrl", ComponentCapability::OpensExternalUrl),
            ("TriggersAutomation", ComponentCapability::TriggersAutomation),
        ],
        "ComponentCapability",
    )
}

fn decode_component_capability_vec(v: &Value) -> Result<Vec<ComponentCapability>, String> {
    let arr = v.as_array().ok_or("capabilities: expected array")?;
    arr.iter().map(decode_component_capability).collect()
}

fn decode_component_type_definition(v: &Value) -> Result<ComponentTypeDefinition, String> {
    let m = obj(v, "component_type_definition")?;
    Ok(ComponentTypeDefinition {
        id: u64_at(m, "id")?,
        component_type: string_at(m, "componentType")?,
        display_name: string_at(m, "displayName")?,
        description: string_at(m, "description")?,
        prop_schema: string_at(m, "propSchema")?,
        capabilities: decode_component_capability_vec(
            m.get("capabilities").ok_or("capabilities")?,
        )?,
        has_yjs_state: bool_at(m, "hasYjsState")?,
        accepts_children: bool_at(m, "acceptsChildren")?,
        is_builtin: bool_at(m, "isBuiltin")?,
        registered_by: decode_identity(m.get("registeredBy").ok_or("registeredBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
    })
}

fn decode_database_row_marker(v: &Value) -> Result<DatabaseRowMarker, String> {
    let m = obj(v, "database_row_marker")?;
    Ok(DatabaseRowMarker {
        id: u64_at(m, "id")?,
        client_request_id: string_at(m, "clientRequestId")?,
        page_id: u64_at(m, "pageId")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
    })
}

fn decode_attachment_kind(v: &Value) -> Result<AttachmentKind, String> {
    decode_enum_tag2(
        v,
        &[
            ("Image", AttachmentKind::Image),
            ("Page", AttachmentKind::Page),
            ("Blocks", AttachmentKind::Blocks),
        ],
        "AttachmentKind",
    )
}

fn decode_conversation_attachment(v: &Value) -> Result<ConversationAttachment, String> {
    let m = obj(v, "conversation_attachment")?;
    Ok(ConversationAttachment {
        id: u64_at(m, "id")?,
        message_id: u64_at(m, "messageId")?,
        conversation_id: u64_at(m, "conversationId")?,
        kind: decode_attachment_kind(m.get("kind").ok_or("kind")?)?,
        object_key: opt_string_at(m, "objectKey")?,
        mime_type: opt_string_at(m, "mimeType")?,
        file_name: opt_string_at(m, "fileName")?,
        page_id: opt_u64_at(m, "pageId")?,
        content_snapshot: opt_string_at(m, "contentSnapshot")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        created_by: decode_identity(m.get("createdBy").ok_or("createdBy")?)?,
    })
}

fn decode_access_request_status(v: &Value) -> Result<AccessRequestStatus, String> {
    decode_enum_tag2(
        v,
        &[
            ("Pending", AccessRequestStatus::Pending),
            ("Approved", AccessRequestStatus::Approved),
            ("Denied", AccessRequestStatus::Denied),
        ],
        "AccessRequestStatus",
    )
}

fn decode_page_access_request(v: &Value) -> Result<PageAccessRequest, String> {
    let m = obj(v, "page_access_request")?;
    Ok(PageAccessRequest {
        id: u64_at(m, "id")?,
        conversation_id: u64_at(m, "conversationId")?,
        page_id: u64_at(m, "pageId")?,
        principal: decode_principal(m.get("principal").ok_or("principal")?)?,
        permission: decode_permission(m.get("permission").ok_or("permission")?)?,
        requested_by: decode_identity(m.get("requestedBy").ok_or("requestedBy")?)?,
        reason: string_at(m, "reason")?,
        status: decode_access_request_status(m.get("status").ok_or("status")?)?,
        requested_at: decode_timestamp(m.get("requestedAt").ok_or("requestedAt")?)?,
        resolved_by: opt_identity_at(m, "resolvedBy")?,
        resolved_at: opt_timestamp_at(m, "resolvedAt")?,
    })
}

/// Decode the `ScheduleAt` tagged union: `{tag:"Interval", value: micros}`
/// (bigint micros, possibly `__pear`-wrapped) or `{tag:"Time", value: ts}`.
fn decode_schedule_at(v: &Value) -> Result<ScheduleAt, String> {
    let o = v.as_object().ok_or("ScheduleAt")?;
    let tag = o
        .get("tag")
        .and_then(|t| t.as_str())
        .ok_or("ScheduleAt.tag")?;
    match tag {
        "Interval" => Ok(ScheduleAt::Interval(TimeDuration::from_micros(decode_i64(
            o.get("value").ok_or("Interval.value")?,
        )?))),
        "Time" => Ok(ScheduleAt::Time(decode_timestamp(
            o.get("value").ok_or("Time.value")?,
        )?)),
        _ => Err(format!("ScheduleAt::{tag}")),
    }
}

/// `ai_user_routine` is a SCHEDULED table: inserting a row re-arms its
/// schedule on the restore target, so imported routines resume ticking on
/// their configured interval. That is intended — routines are standing
/// instructions, not one-shot state.
fn decode_ai_user_routine(v: &Value) -> Result<AiUserRoutine, String> {
    let m = obj(v, "ai_user_routine")?;
    Ok(AiUserRoutine {
        scheduled_id: u64_at(m, "scheduledId")?,
        scheduled_at: decode_schedule_at(m.get("scheduledAt").ok_or("scheduledAt")?)?,
        ai_user_id: u64_at(m, "aiUserId")?,
        prompt: string_at(m, "prompt")?,
        enabled: bool_at(m, "enabled")?,
        created_by: decode_identity(m.get("createdBy").ok_or("createdBy")?)?,
        conversation_id: opt_u64_at(m, "conversationId")?,
        interval_secs: u64_at(m, "intervalSecs")?,
        last_run_at: opt_timestamp_at(m, "lastRunAt")?,
        last_status: opt_string_at(m, "lastStatus")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        // Added in beta.6; absent from older snapshots -> interval defaults.
        schedule_kind: match m.get("scheduleKind") {
            Some(v) => decode_enum_tag2(
                v,
                &[
                    ("Interval", RoutineScheduleKind::Interval),
                    ("Cron", RoutineScheduleKind::Cron),
                ],
                "RoutineScheduleKind",
            )?,
            None => RoutineScheduleKind::Interval,
        },
        cron_expression: opt_string_at(m, "cronExpression")?,
        timezone: opt_string_at(m, "timezone")?,
    })
}

fn decode_ai_primitive(v: &Value) -> Result<AiPrimitive, String> {
    decode_enum_tag2(
        v,
        &[
            ("Classify", AiPrimitive::Classify),
            ("Extract", AiPrimitive::Extract),
            ("Summarize", AiPrimitive::Summarize),
            ("Sentiment", AiPrimitive::Sentiment),
            ("Translate", AiPrimitive::Translate),
        ],
        "AiPrimitive",
    )
}

fn decode_ai_evaluation(v: &Value) -> Result<AiEvaluation, String> {
    let m = obj(v, "ai_evaluation")?;
    Ok(AiEvaluation {
        id: u64_at(m, "id")?,
        property_definition_id: u64_at(m, "propertyDefinitionId")?,
        page_id: u64_at(m, "pageId")?,
        input_hash: string_at(m, "inputHash")?,
        primitive: decode_ai_primitive(m.get("primitive").ok_or("primitive")?)?,
        model: string_at(m, "model")?,
        prompt_version: u64_at(m, "promptVersion")? as u32,
        output: string_at(m, "output")?,
        input_tokens: u64_at(m, "inputTokens")? as u32,
        output_tokens: u64_at(m, "outputTokens")? as u32,
        cost_microcents: u64_at(m, "costMicrocents")?,
        wall_clock_ms: u64_at(m, "wallClockMs")? as u32,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        ai_user_identity: decode_identity(m.get("aiUserIdentity").ok_or("aiUserIdentity")?)?,
        is_stale: bool_at(m, "isStale")?,
    })
}

fn decode_message_feedback_rating(v: &Value) -> Result<MessageFeedbackRating, String> {
    decode_enum_tag2(
        v,
        &[
            ("Up", MessageFeedbackRating::Up),
            ("Down", MessageFeedbackRating::Down),
        ],
        "MessageFeedbackRating",
    )
}

fn decode_message_feedback(v: &Value) -> Result<MessageFeedback, String> {
    let m = obj(v, "message_feedback")?;
    Ok(MessageFeedback {
        id: u64_at(m, "id")?,
        message_id: u64_at(m, "messageId")?,
        conversation_id: u64_at(m, "conversationId")?,
        rater: decode_identity(m.get("rater").ok_or("rater")?)?,
        rating: decode_message_feedback_rating(m.get("rating").ok_or("rating")?)?,
        note: string_at(m, "note")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

fn decode_orcha_usage_event(v: &Value) -> Result<OrchaUsageEvent, String> {
    let m = obj(v, "orcha_usage_event")?;
    Ok(OrchaUsageEvent {
        id: u64_at(m, "id")?,
        task_id: u64_at(m, "taskId")?,
        task_type: string_at(m, "taskType")?,
        agent_id: string_at(m, "agentId")?,
        ai_user_id: opt_u64_at(m, "aiUserId")?,
        tokens_in: u64_at(m, "tokensIn")?,
        tokens_out: u64_at(m, "tokensOut")?,
        wall_clock_ms: u64_at(m, "wallClockMs")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
    })
}

fn decode_api_call_log(v: &Value) -> Result<ApiCallLog, String> {
    let m = obj(v, "api_call_log")?;
    Ok(ApiCallLog {
        id: u64_at(m, "id")?,
        endpoint_id: u64_at(m, "endpointId")?,
        key_id: opt_u64_at(m, "keyId")?,
        method: decode_http_method(m.get("method").ok_or("method")?)?,
        path: string_at(m, "path")?,
        status_code: u64_at(m, "statusCode")? as u16,
        latency_ms: u64_at(m, "latencyMs")? as u32,
        caller_ip: opt_string_at(m, "callerIp")?,
        error_message: opt_string_at(m, "errorMessage")?,
        at: decode_timestamp(m.get("at").ok_or("at")?)?,
    })
}

fn decode_automation_mode(v: &Value) -> Result<AutomationMode, String> {
    decode_enum_tag2(
        v,
        &[
            ("DryRun", AutomationMode::DryRun),
            ("Live", AutomationMode::Live),
        ],
        "AutomationMode",
    )
}

fn decode_automation_trigger_kind(v: &Value) -> Result<AutomationTriggerKind, String> {
    decode_enum_tag2(
        v,
        &[
            ("PageCreated", AutomationTriggerKind::PageCreated),
            ("PageUpdated", AutomationTriggerKind::PageUpdated),
            ("PageDeleted", AutomationTriggerKind::PageDeleted),
            ("PropertyChanged", AutomationTriggerKind::PropertyChanged),
            ("Scheduled", AutomationTriggerKind::Scheduled),
        ],
        "AutomationTriggerKind",
    )
}

fn decode_automation_schedule_kind(v: &Value) -> Result<AutomationScheduleKind, String> {
    decode_enum_tag2(
        v,
        &[
            ("None", AutomationScheduleKind::None),
            ("Interval", AutomationScheduleKind::Interval),
            ("OneShot", AutomationScheduleKind::OneShot),
            ("Cron", AutomationScheduleKind::Cron),
        ],
        "AutomationScheduleKind",
    )
}

fn decode_automation_action_kind(v: &Value) -> Result<AutomationActionKind, String> {
    decode_enum_tag2(
        v,
        &[
            ("HttpRequest", AutomationActionKind::HttpRequest),
            ("SendEmail", AutomationActionKind::SendEmail),
            ("CreatePage", AutomationActionKind::CreatePage),
            ("UpdateProperty", AutomationActionKind::UpdateProperty),
            ("OrchaJob", AutomationActionKind::OrchaJob),
        ],
        "AutomationActionKind",
    )
}

fn decode_automation_condition_kind(v: &Value) -> Result<AutomationConditionKind, String> {
    decode_enum_tag2(
        v,
        &[(
            "PayloadFieldEquals",
            AutomationConditionKind::PayloadFieldEquals,
        )],
        "AutomationConditionKind",
    )
}

fn decode_automation_capability_kind(v: &Value) -> Result<AutomationCapabilityKind, String> {
    decode_enum_tag2(
        v,
        &[
            ("ReadPage", AutomationCapabilityKind::ReadPage),
            ("WritePage", AutomationCapabilityKind::WritePage),
            ("HttpOutbound", AutomationCapabilityKind::HttpOutbound),
            ("SendEmail", AutomationCapabilityKind::SendEmail),
            ("SpendAiTokens", AutomationCapabilityKind::SpendAiTokens),
            ("SpawnOrchaJob", AutomationCapabilityKind::SpawnOrchaJob),
        ],
        "AutomationCapabilityKind",
    )
}

fn decode_automation_event_status(v: &Value) -> Result<AutomationEventStatus, String> {
    decode_enum_tag2(
        v,
        &[
            ("Pending", AutomationEventStatus::Pending),
            ("Running", AutomationEventStatus::Running),
            ("Completed", AutomationEventStatus::Completed),
            ("Failed", AutomationEventStatus::Failed),
            ("Skipped", AutomationEventStatus::Skipped),
        ],
        "AutomationEventStatus",
    )
}

fn decode_automation_rule(v: &Value) -> Result<AutomationRule, String> {
    let m = obj(v, "automation_rule")?;
    Ok(AutomationRule {
        id: u64_at(m, "id")?,
        name: string_at(m, "name")?,
        enabled: bool_at(m, "enabled")?,
        mode: decode_automation_mode(m.get("mode").ok_or("mode")?)?,
        trigger_kind: decode_automation_trigger_kind(m.get("triggerKind").ok_or("triggerKind")?)?,
        trigger_config: string_at(m, "triggerConfig")?,
        schedule_kind: decode_automation_schedule_kind(
            m.get("scheduleKind").ok_or("scheduleKind")?,
        )?,
        schedule_config: string_at(m, "scheduleConfig")?,
        timezone: string_at(m, "timezone")?,
        next_run_at: opt_timestamp_at(m, "nextRunAt")?,
        last_run_at: opt_timestamp_at(m, "lastRunAt")?,
        max_ticks: opt_u64_at(m, "maxTicks")?,
        tick_count: u64_at(m, "tickCount")?,
        expires_at: opt_timestamp_at(m, "expiresAt")?,
        run_as: decode_identity(m.get("runAs").ok_or("runAs")?)?,
        created_by: decode_identity(m.get("createdBy").ok_or("createdBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
        canonical_description: string_at(m, "canonicalDescription")?,
    })
}

fn decode_automation_action(v: &Value) -> Result<AutomationAction, String> {
    let m = obj(v, "automation_action")?;
    Ok(AutomationAction {
        id: u64_at(m, "id")?,
        automation_id: u64_at(m, "automationId")?,
        order: u64_at(m, "order")? as u32,
        action_kind: decode_automation_action_kind(m.get("actionKind").ok_or("actionKind")?)?,
        config: string_at(m, "config")?,
    })
}

fn decode_automation_condition(v: &Value) -> Result<AutomationCondition, String> {
    let m = obj(v, "automation_condition")?;
    Ok(AutomationCondition {
        id: u64_at(m, "id")?,
        automation_id: u64_at(m, "automationId")?,
        order: u64_at(m, "order")? as u32,
        condition_kind: decode_automation_condition_kind(
            m.get("conditionKind").ok_or("conditionKind")?,
        )?,
        config: string_at(m, "config")?,
    })
}

fn decode_automation_capability(v: &Value) -> Result<AutomationCapability, String> {
    let m = obj(v, "automation_capability")?;
    Ok(AutomationCapability {
        id: u64_at(m, "id")?,
        automation_id: u64_at(m, "automationId")?,
        capability_kind: decode_automation_capability_kind(
            m.get("capabilityKind").ok_or("capabilityKind")?,
        )?,
        scope_config: string_at(m, "scopeConfig")?,
    })
}

fn decode_automation_event_queue(v: &Value) -> Result<AutomationEventQueue, String> {
    let m = obj(v, "automation_event_queue")?;
    Ok(AutomationEventQueue {
        id: u64_at(m, "id")?,
        automation_id: u64_at(m, "automationId")?,
        trigger_kind: decode_automation_trigger_kind(m.get("triggerKind").ok_or("triggerKind")?)?,
        trigger_payload: string_at(m, "triggerPayload")?,
        status: decode_automation_event_status(m.get("status").ok_or("status")?)?,
        attempts: u64_at(m, "attempts")? as u32,
        claimed_by: opt_string_at(m, "claimedBy")?,
        error: opt_string_at(m, "error")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

fn decode_automation_run_log(v: &Value) -> Result<AutomationRunLog, String> {
    let m = obj(v, "automation_run_log")?;
    Ok(AutomationRunLog {
        id: u64_at(m, "id")?,
        queue_id: u64_at(m, "queueId")?,
        action_id: opt_u64_at(m, "actionId")?,
        success: bool_at(m, "success")?,
        dry_run: bool_at(m, "dryRun")?,
        message: string_at(m, "message")?,
        result_json: string_at(m, "resultJson")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
    })
}

fn decode_bridge_command_status(v: &Value) -> Result<BridgeCommandStatus, String> {
    decode_enum_tag2(
        v,
        &[
            ("Pending", BridgeCommandStatus::Pending),
            (
                "AwaitingConfirmation",
                BridgeCommandStatus::AwaitingConfirmation,
            ),
            ("Running", BridgeCommandStatus::Running),
            ("Completed", BridgeCommandStatus::Completed),
            ("Failed", BridgeCommandStatus::Failed),
            ("Rejected", BridgeCommandStatus::Rejected),
            ("TimedOut", BridgeCommandStatus::TimedOut),
        ],
        "BridgeCommandStatus",
    )
}

fn decode_bridge_command(v: &Value) -> Result<BridgeCommand, String> {
    let m = obj(v, "bridge_command")?;
    Ok(BridgeCommand {
        id: u64_at(m, "id")?,
        device_id: u64_at(m, "deviceId")?,
        session_id: u64_at(m, "sessionId")?,
        conversation_id: u64_at(m, "conversationId")?,
        job_id: opt_u64_at(m, "jobId")?,
        task_id: opt_u64_at(m, "taskId")?,
        requested_by: decode_identity(m.get("requestedBy").ok_or("requestedBy")?)?,
        command: string_at(m, "command")?,
        cwd: opt_string_at(m, "cwd")?,
        enqueued_at: decode_timestamp(m.get("enqueuedAt").ok_or("enqueuedAt")?)?,
        status: decode_bridge_command_status(m.get("status").ok_or("status")?)?,
        requires_confirmation: bool_at(m, "requiresConfirmation")?,
        confirmed_at: opt_timestamp_at(m, "confirmedAt")?,
        confirmed_by: opt_identity_at(m, "confirmedBy")?,
        // `#[default(Identity::ZERO)]` columns — fall back like the schema.
        device_identity: identity_at_or_zero(m, "deviceIdentity")?,
        owner_identity: identity_at_or_zero(m, "ownerIdentity")?,
        nonce: opt_string_at(m, "nonce")?,
    })
}

fn decode_bridge_command_result(v: &Value) -> Result<BridgeCommandResult, String> {
    let m = obj(v, "bridge_command_result")?;
    Ok(BridgeCommandResult {
        command_id: u64_at(m, "commandId")?,
        exit_code: opt_i32_at(m, "exitCode")?,
        stdout: string_at(m, "stdout")?,
        stderr: string_at(m, "stderr")?,
        rejection_reason: opt_string_at(m, "rejectionReason")?,
        duration_ms: u64_at(m, "durationMs")?,
        completed_at: decode_timestamp(m.get("completedAt").ok_or("completedAt")?)?,
        output_hash: string_at(m, "outputHash")?,
        // `#[default(Identity::ZERO)]` column.
        requested_by: identity_at_or_zero(m, "requestedBy")?,
    })
}

fn decode_unlisted_command_policy(v: &Value) -> Result<UnlistedCommandPolicy, String> {
    decode_enum_tag2(
        v,
        &[
            ("Prompt", UnlistedCommandPolicy::Prompt),
            ("Reject", UnlistedCommandPolicy::Reject),
        ],
        "UnlistedCommandPolicy",
    )
}

fn decode_bridge_device_allowlist(v: &Value) -> Result<BridgeDeviceAllowlist, String> {
    let m = obj(v, "bridge_device_allowlist")?;
    Ok(BridgeDeviceAllowlist {
        device_id: u64_at(m, "deviceId")?,
        allowed_commands: string_vec_at(m, "allowedCommands")?,
        blocked_patterns: string_vec_at(m, "blockedPatterns")?,
        allowed_directories: string_vec_at(m, "allowedDirectories")?,
        require_confirmation_for: string_vec_at(m, "requireConfirmationFor")?,
        max_output_bytes: u64_at(m, "maxOutputBytes")?,
        max_runtime_seconds: u64_at(m, "maxRuntimeSeconds")?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
        updated_by: decode_identity(m.get("updatedBy").ok_or("updatedBy")?)?,
        // `#[default(UnlistedCommandPolicy::Prompt)]` column.
        unlisted_command_policy: match m.get("unlistedCommandPolicy") {
            None | Some(Value::Null) => UnlistedCommandPolicy::Prompt,
            Some(v) => decode_unlisted_command_policy(v)?,
        },
        // `#[default(Identity::ZERO)]` column.
        device_identity: identity_at_or_zero(m, "deviceIdentity")?,
    })
}

fn decode_bridge_device_grant(v: &Value) -> Result<BridgeDeviceGrant, String> {
    let m = obj(v, "bridge_device_grant")?;
    Ok(BridgeDeviceGrant {
        id: u64_at(m, "id")?,
        device_id: u64_at(m, "deviceId")?,
        ai_user_identity: decode_identity(m.get("aiUserIdentity").ok_or("aiUserIdentity")?)?,
        granted_by: decode_identity(m.get("grantedBy").ok_or("grantedBy")?)?,
        granted_at: decode_timestamp(m.get("grantedAt").ok_or("grantedAt")?)?,
    })
}

fn decode_bridge_device_summary(v: &Value) -> Result<BridgeDeviceSummary, String> {
    let m = obj(v, "bridge_device_summary")?;
    Ok(BridgeDeviceSummary {
        id: u64_at(m, "id")?,
        name: string_at(m, "name")?,
        platform: string_at(m, "platform")?,
        connected: bool_at(m, "connected")?,
        revoked_at: opt_timestamp_at(m, "revokedAt")?,
    })
}

fn decode_structural_sensor_finding(v: &Value) -> Result<StructuralSensorFinding, String> {
    let m = obj(v, "structural_sensor_finding")?;
    Ok(StructuralSensorFinding {
        id: u64_at(m, "id")?,
        sensor_kind: string_at(m, "sensorKind")?,
        code: string_at(m, "code")?,
        target_kind: string_at(m, "targetKind")?,
        target_id: u64_at(m, "targetId")?,
        message: string_at(m, "message")?,
        severity: string_at(m, "severity")?,
        details_json: string_at(m, "detailsJson")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        last_seen_at: decode_timestamp(m.get("lastSeenAt").ok_or("lastSeenAt")?)?,
        // `#[default(None::<Timestamp>)]` column — absent falls back to None.
        resolved_at: opt_timestamp_at(m, "resolvedAt")?,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod pear_v2_tests {
    use super::*;
    use serde_json::json;

    const TS: &str = r#"{"__pear":"timestamp","v":"1700000000000000"}"#;
    const ID_HEX: &str = "c200000000000000000000000000000000000000000000000000000000000042";

    fn ts() -> Value {
        serde_json::from_str(TS).unwrap()
    }

    fn ident() -> Value {
        json!({"__pear": "identity", "v": ID_HEX})
    }

    /// Keep in sync with `PEAR_SNAPSHOT_V2_FORMAT` in
    /// `pear/web/src/lib/pearExport.ts` and `snapshot_tables_v2.json`.
    #[test]
    fn portable_snapshot_format_constant() {
        assert_eq!(FORMAT, "pear-snapshot-v2");
    }

    /// The importer's dispatch table must equal the policy's include list
    /// exactly — a module table added without updating both fails here (and
    /// the TS-side twin in `pear/web/src/lib/pearExport.test.ts`).
    #[test]
    fn dispatch_table_matches_policy_include_list() {
        let policy: Value =
            serde_json::from_str(include_str!("../../snapshot_tables_v2.json")).unwrap();
        assert_eq!(policy["format"].as_str(), Some(FORMAT));
        let include: Vec<&str> = policy["include"]
            .as_array()
            .expect("policy include list")
            .iter()
            .map(|v| v.as_str().expect("table name"))
            .collect();

        let policy_set: std::collections::BTreeSet<&str> = include.iter().copied().collect();
        let dispatch_set: std::collections::BTreeSet<&str> =
            IMPORT_V2_TABLES.iter().copied().collect();
        assert_eq!(include.len(), policy_set.len(), "duplicate in policy include list");
        assert_eq!(
            IMPORT_V2_TABLES.len(),
            dispatch_set.len(),
            "duplicate in IMPORT_V2_TABLES"
        );
        assert_eq!(
            dispatch_set, policy_set,
            "IMPORT_V2_TABLES and snapshot_tables_v2.json include list diverged"
        );
    }

    #[test]
    fn decodes_component_node() {
        let row = json!({
            "id": {"__pear": "bigint", "v": "12"},
            "surfaceId": 7,
            "parentId": null,
            "componentType": "Container",
            "props": "{\"layout\":\"stack\"}",
            "order": 1000,
            "createdBy": {"tag": "Human"},
            "updatedBy": {"tag": "Agent", "value": "kira"},
            "createdAt": ts(),
            "updatedAt": ts(),
            "deletedAt": null,
        });
        let node = decode_component_node(&row).unwrap();
        assert_eq!(node.id, 12);
        assert_eq!(node.surface_id, 7);
        assert_eq!(node.parent_id, None);
        assert_eq!(node.component_type, "Container");
        assert_eq!(node.order, 1000);
        assert_eq!(node.created_by, crate::ActorType::Human);
        assert_eq!(node.updated_by, crate::ActorType::Agent("kira".to_string()));
        assert_eq!(node.deleted_at, None);
        assert_eq!(
            node.created_at,
            Timestamp::from_micros_since_unix_epoch(1_700_000_000_000_000)
        );
    }

    #[test]
    fn decodes_schedule_at_interval_and_time() {
        let interval = json!({"tag": "Interval", "value": {"__pear": "bigint", "v": "300000000"}});
        assert_eq!(
            decode_schedule_at(&interval).unwrap(),
            ScheduleAt::Interval(TimeDuration::from_micros(300_000_000))
        );

        let time = json!({"tag": "Time", "value": {"__pear": "timestamp", "v": "1700000000000000"}});
        assert_eq!(
            decode_schedule_at(&time).unwrap(),
            ScheduleAt::Time(Timestamp::from_micros_since_unix_epoch(1_700_000_000_000_000))
        );

        assert!(decode_schedule_at(&json!({"tag": "Never"})).is_err());
    }

    #[test]
    fn decodes_ai_user_routine_row() {
        let row = json!({
            "scheduledId": 3,
            "scheduledAt": {"tag": "Interval", "value": "3600000000"},
            "aiUserId": 1,
            "prompt": "Consolidate your private memory.",
            "enabled": true,
            "createdBy": ident(),
            "conversationId": null,
            "intervalSecs": {"__pear": "bigint", "v": "3600"},
            "lastRunAt": null,
            "lastStatus": "ran",
            "createdAt": ts(),
        });
        let routine = decode_ai_user_routine(&row).unwrap();
        assert_eq!(routine.scheduled_id, 3);
        assert_eq!(
            routine.scheduled_at,
            ScheduleAt::Interval(TimeDuration::from_micros(3_600_000_000))
        );
        assert_eq!(routine.interval_secs, 3600);
        assert_eq!(routine.conversation_id, None);
        assert_eq!(routine.last_status.as_deref(), Some("ran"));
    }

    /// Builtin component types are re-seeded by init; the chunk importer's
    /// guard skips any decoded row with `is_builtin == true` (see the
    /// `component_type_definition` arm in `import_rows`).
    #[test]
    fn builtin_component_type_definition_decodes_as_builtin() {
        let row = json!({
            "id": 1,
            "componentType": "Container",
            "displayName": "Container",
            "description": "Layout container.",
            "propSchema": "{}",
            "capabilities": [{"tag": "ReadsDatabase"}, "WritesDatabase"],
            "hasYjsState": false,
            "acceptsChildren": true,
            "isBuiltin": true,
            "registeredBy": ident(),
            "createdAt": ts(),
        });
        let def = decode_component_type_definition(&row).unwrap();
        assert!(def.is_builtin, "guard keys on is_builtin");
        assert_eq!(
            def.capabilities,
            vec![
                ComponentCapability::ReadsDatabase,
                ComponentCapability::WritesDatabase
            ]
        );
    }

    // NOTE (manual verification): the id_counter reset in `import_v2_commit`
    // (delete every `id_counter` row so the next `alloc_id` re-seeds from the
    // post-import max(id) — see id_counters.rs) requires a `ReducerContext`
    // and cannot be unit-tested off-host. Verify on a dev module with:
    //   1. import a snapshot, 2. `SELECT * FROM id_counter` → empty,
    //   3. create a page → id == max(imported page id) + 1.
}
