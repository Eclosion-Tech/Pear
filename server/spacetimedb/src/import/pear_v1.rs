//! Import [`PEAR_SNAPSHOT_FORMAT`](crate) JSON produced by the web client's `buildPearSnapshotV1`.

use super::decode::*;
use crate::{
    ai_user_config, ai_user_memory, ai_user_profile, api_endpoint, api_endpoint_key,
    api_field_mapping, attachment, auto_apply_binding, block_access_rule, conversation,
    conversation_message, conversation_participant, database_schema, database_view,
    extension_manifest, harness_template, installed_extension, orcha_agent, orcha_job,
    orcha_shared_context, orcha_task, page, page_access_rule, page_content, page_property_value,
    page_property_value_history, page_snapshot, page_yjs_state, property_definition,
    review_agent_binding, review_annotation, user, user_preference,
};
use crate::{
    AiUserConfig, AiUserProfile, AiUserRole, Conversation, ConversationKind,
    ConversationVisibility, ExtensionManifest, HarnessTemplateSource, InferenceProvider, OrchaJob,
    OrchaTask, Page, PageContentFormat, User,
};
use serde_json::Value;
use spacetimedb::{reducer, ReducerContext, Table};

const FORMAT: &str = "pear-snapshot-v1";

/// Import a `pear-snapshot-v1` JSON file exported from the Pear web app.
/// Only succeeds when the database has **no pages** (empty workspace). Requires an authenticated user.
/// AI users are restored with **stub** private `AiUserConfig` rows (no API keys); reconfigure after import.
#[reducer]
pub fn import_pear_snapshot_v1(ctx: &ReducerContext, snapshot_json: String) -> Result<(), String> {
    apply_snapshot(ctx, &snapshot_json)
}

fn apply_snapshot(ctx: &ReducerContext, snapshot_json: &str) -> Result<(), String> {
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

    let root: Value =
        serde_json::from_str(snapshot_json).map_err(|e| format!("JSON parse: {e}"))?;
    let format = root
        .get("format")
        .and_then(|v| v.as_str())
        .ok_or("missing format")?;
    if format != FORMAT {
        return Err(format!("unsupported format: {format}"));
    }

    let tables = root.get("tables").ok_or("missing tables")?;

    import_users(ctx, tables)?;
    import_user_preference(ctx, tables)?;
    import_pages(ctx, tables)?;
    import_page_content(ctx, tables)?;
    import_page_yjs_state(ctx, tables)?;
    import_database_schema(ctx, tables)?;
    import_property_definition(ctx, tables)?;
    import_database_view(ctx, tables)?;
    import_page_property_value(ctx, tables)?;
    import_page_property_value_history(ctx, tables)?;
    import_page_snapshot(ctx, tables)?;
    import_attachment(ctx, tables)?;
    import_page_access_rule(ctx, tables)?;
    import_block_access_rule(ctx, tables)?;
    import_ai_user_profile(ctx, tables)?;
    import_ai_user_memory(ctx, tables)?;
    import_conversation(ctx, tables)?;
    import_conversation_participant(ctx, tables)?;
    import_conversation_message(ctx, tables)?;
    import_harness_template(ctx, tables)?;
    import_review_agent_binding(ctx, tables)?;
    import_review_annotation(ctx, tables)?;
    import_auto_apply_binding(ctx, tables)?;
    import_extension_manifest(ctx, tables)?;
    import_installed_extension(ctx, tables)?;
    import_orcha_agent(ctx, tables)?;
    import_orcha_job(ctx, tables)?;
    import_orcha_task(ctx, tables)?;
    import_orcha_shared_context(ctx, tables)?;
    import_api_endpoint(ctx, tables)?;
    import_api_field_mapping(ctx, tables)?;
    import_api_endpoint_key(ctx, tables)?;

    Ok(())
}

// ── Table importers ───────────────────────────────────────────────────────────

fn import_users(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("user").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        let u: User = decode_user(row)?;
        ctx.db.user().insert(u);
    }
    Ok(())
}

fn import_pages(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("page").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    let mut rows: Vec<Page> = arr.iter().map(decode_page).collect::<Result<_, _>>()?;
    // Parents before children
    rows.sort_by_key(|p| p.id);
    let mut remaining: Vec<Page> = rows;
    let mut safety = remaining.len() + 1;
    while !remaining.is_empty() {
        if safety == 0 {
            return Err("page parent_id cycle or missing parent in snapshot".into());
        }
        safety -= 1;
        let mut next_pass = Vec::new();
        for p in remaining {
            let parent_ok = match p.parent_id {
                None => true,
                Some(pid) => ctx.db.page().id().find(pid).is_some(),
            };
            if parent_ok {
                ctx.db.page().insert(p);
            } else {
                next_pass.push(p);
            }
        }
        remaining = next_pass;
    }
    Ok(())
}

fn import_page_content(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("page_content").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.page_content().insert(decode_page_content(row)?);
    }
    Ok(())
}

fn import_page_yjs_state(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("page_yjs_state").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.page_yjs_state().insert(decode_page_yjs_state(row)?);
    }
    Ok(())
}

fn import_database_schema(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("database_schema").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .database_schema()
            .insert(decode_database_schema(row)?);
    }
    Ok(())
}

fn import_property_definition(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("property_definition").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .property_definition()
            .insert(decode_property_definition(row)?);
    }
    Ok(())
}

fn import_database_view(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("database_view").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.database_view().insert(decode_database_view(row)?);
    }
    Ok(())
}

fn import_page_property_value(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("page_property_value").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .page_property_value()
            .insert(decode_page_property_value(row)?);
    }
    Ok(())
}

fn import_page_property_value_history(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables
        .get("page_property_value_history")
        .and_then(|v| v.as_array())
    else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .page_property_value_history()
            .insert(decode_page_property_value_history(row)?);
    }
    Ok(())
}

fn import_page_snapshot(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("page_snapshot").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.page_snapshot().insert(decode_page_snapshot(row)?);
    }
    Ok(())
}

fn import_attachment(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("attachment").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.attachment().insert(decode_attachment(row)?);
    }
    Ok(())
}

fn import_ai_user_profile(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("ai_user_profile").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        let p: AiUserProfile = decode_ai_user_profile(row)?;
        // Restore AI users with stub AiUserConfig (no api_key) so FKs resolve.
        // Operators must reconfigure provider/model/key after import via the
        // out-of-band admin / HTTP tooling — minted Identities aren't recoverable
        // from an exported snapshot, so the imported `identity` carries over
        // but no fresh token is provisioned by this path.
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
                inference_backend_json: None,
            });
        }
        ctx.db.ai_user_profile().insert(p);
    }
    Ok(())
}

fn import_conversation(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("conversation").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.conversation().insert(decode_conversation(row)?);
    }
    Ok(())
}

fn import_conversation_participant(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables
        .get("conversation_participant")
        .and_then(|v| v.as_array())
    else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .conversation_participant()
            .insert(decode_conversation_participant(row)?);
    }
    Ok(())
}

fn import_conversation_message(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables
        .get("conversation_message")
        .and_then(|v| v.as_array())
    else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .conversation_message()
            .insert(decode_conversation_message(row)?);
    }
    Ok(())
}

fn import_extension_manifest(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("extension_manifest").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .extension_manifest()
            .insert(decode_extension_manifest(row)?);
    }
    Ok(())
}

fn import_installed_extension(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("installed_extension").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .installed_extension()
            .insert(decode_installed_extension(row)?);
    }
    Ok(())
}

fn import_orcha_agent(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("orcha_agent").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.orcha_agent().insert(decode_orcha_agent(row)?);
    }
    Ok(())
}

fn import_orcha_job(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("orcha_job").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.orcha_job().insert(decode_orcha_job(row)?);
    }
    Ok(())
}

fn import_orcha_task(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("orcha_task").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.orcha_task().insert(decode_orcha_task(row)?);
    }
    Ok(())
}

fn import_orcha_shared_context(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables
        .get("orcha_shared_context")
        .and_then(|v| v.as_array())
    else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .orcha_shared_context()
            .insert(decode_orcha_shared_context(row)?);
    }
    Ok(())
}

fn import_user_preference(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("user_preference").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .user_preference()
            .insert(decode_user_preference(row)?);
    }
    Ok(())
}

fn import_page_access_rule(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("page_access_rule").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .page_access_rule()
            .insert(decode_page_access_rule(row)?);
    }
    Ok(())
}

fn import_block_access_rule(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("block_access_rule").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .block_access_rule()
            .insert(decode_block_access_rule(row)?);
    }
    Ok(())
}

fn import_ai_user_memory(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("ai_user_memory").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.ai_user_memory().insert(decode_ai_user_memory(row)?);
    }
    Ok(())
}

fn import_harness_template(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("harness_template").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    // Skip Builtin templates — they are seeded automatically by the new
    // module on init and would otherwise trip the unique `external_id`
    // constraint. Workspace-authored templates are preserved verbatim.
    for row in arr {
        let t = decode_harness_template(row)?;
        if matches!(t.source, HarnessTemplateSource::Builtin) {
            continue;
        }
        ctx.db.harness_template().insert(t);
    }
    Ok(())
}

fn import_review_agent_binding(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables
        .get("review_agent_binding")
        .and_then(|v| v.as_array())
    else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .review_agent_binding()
            .insert(decode_review_agent_binding(row)?);
    }
    Ok(())
}

fn import_review_annotation(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("review_annotation").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .review_annotation()
            .insert(decode_review_annotation(row)?);
    }
    Ok(())
}

fn import_auto_apply_binding(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("auto_apply_binding").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .auto_apply_binding()
            .insert(decode_auto_apply_binding(row)?);
    }
    Ok(())
}

fn import_api_endpoint(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("api_endpoint").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.api_endpoint().insert(decode_api_endpoint(row)?);
    }
    Ok(())
}

fn import_api_field_mapping(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("api_field_mapping").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .api_field_mapping()
            .insert(decode_api_field_mapping(row)?);
    }
    Ok(())
}

fn import_api_endpoint_key(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("api_endpoint_key").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db
            .api_endpoint_key()
            .insert(decode_api_endpoint_key(row)?);
    }
    Ok(())
}

// ── v1-specific decoders ──────────────────────────────────────────────────────
//
// These deliberately DIFFER from their `pear_v2` counterparts: the v1 format
// is frozen, so fields that post-date it are filled with fixed defaults and
// enum variants that post-date it are rejected. Shared decoders live in
// `super::decode`.

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
        // Older snapshots predate the field; default visible.
        is_hidden: bool_at_or(m, "isHidden", false),
        // Pre-migration snapshots have no contentFormat. Default to BlockNote
        // because the snapshot's content is BlockNote JSON in PageContent.
        // Snapshot-field-reading lands with the migration tool's ADR.
        content_format: PageContentFormat::BlockNote,
    })
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
        // Older snapshots predate visibility — default Private (most
        // restrictive safe default; expansion is reversible by the owner).
        visibility: ConversationVisibility::Private,
        kind: ConversationKind::ContextThread,
        canonical_key: None,
        block_anchor: None,
        model_override: None,
        effort_override: None,
        resolved_by: None,
        resolved_at: None,
    })
}

fn decode_extension_manifest(v: &Value) -> Result<ExtensionManifest, String> {
    let m = obj(v, "extension_manifest")?;
    let author = match m.get("authorIdentity") {
        None | Some(Value::Null) => None,
        Some(v) => Some(decode_identity(v)?),
    };
    Ok(ExtensionManifest {
        id: u64_at(m, "id")?,
        name: string_at(m, "name")?,
        description: string_at(m, "description")?,
        extension_type: decode_extension_type(m.get("extensionType").ok_or("extensionType")?)?,
        version: string_at(m, "version")?,
        author_identity: author,
        manifest_json: string_at(m, "manifestJson")?,
        source_url: opt_string_at(m, "sourceUrl")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
    })
}

fn decode_extension_type(v: &Value) -> Result<crate::ExtensionType, String> {
    let o = v.as_object().ok_or("ExtensionType")?;
    let tag = o
        .get("tag")
        .and_then(|t| t.as_str())
        .ok_or("ExtensionType.tag")?;
    match tag {
        "ConfigBundle" => Ok(crate::ExtensionType::ConfigBundle),
        "McpServer" => Ok(crate::ExtensionType::McpServer),
        "Hybrid" => Ok(crate::ExtensionType::Hybrid),
        _ => Err(format!("ExtensionType::{tag}")),
    }
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
        spawning_principal: spacetimedb::Identity::ZERO,
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
        required_capabilities: m
            .get("requiredCapabilities")
            .and_then(|v| v.as_array())
            .ok_or("requiredCapabilities")?
            .iter()
            .map(|x| {
                x.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| "orcha_task.cap".to_string())
            })
            .collect::<Result<Vec<_>, String>>()?,
        assigned_to: opt_string_at(m, "assignedTo")?,
        result: opt_string_at(m, "result")?,
        // v1 exports predate the claim lease; imported tasks start unclaimed.
        claimed_at: None,
    })
}

#[cfg(test)]
mod snapshot_format_tests {
    use super::FORMAT;

    /// Keep in sync with `PEAR_SNAPSHOT_FORMAT` in `pear/web/src/lib/pearExport.ts`.
    #[test]
    fn portable_snapshot_format_constant() {
        assert_eq!(FORMAT, "pear-snapshot-v1");
    }
}
