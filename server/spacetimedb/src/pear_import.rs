//! Import [`PEAR_SNAPSHOT_FORMAT`](crate) JSON produced by the web client's `buildPearSnapshotV1`.

use crate::{
    attachment, ai_user_config, ai_user_profile, conversation, conversation_message,
    conversation_participant, database_schema, database_view, extension_manifest,
    installed_extension, orcha_agent, orcha_job, orcha_task, orcha_shared_context, page,
    page_content, page_property_value, page_property_value_history, page_snapshot, page_yjs_state,
    property_definition, user,
};
use crate::{
    ActorType, AiUserConfig, AiUserProfile, Attachment, Conversation, ConversationMessage,
    ConversationParticipant, ConversationStatus, DatabaseSchema, DatabaseView, ExtensionManifest,
    InferenceProvider, InstalledExtension, MessageSender, MessageStatus, OrchaAgent, OrchaJob,
    OrchaSharedContext, OrchaTask, Page, PageContent, PagePropertyValue, PagePropertyValueHistory,
    PageSnapshot, PageType, PageYjsState, ParticipantRole, PropertyDefinition, PropertyType,
    PropertyValue, SnapshotType, User, ViewType,
};
use hex;
use serde_json::Value;
use spacetimedb::{Identity, ReducerContext, Table, Timestamp};

const FORMAT: &str = "pear-snapshot-v1";

pub fn apply_snapshot(ctx: &ReducerContext, snapshot_json: &str) -> Result<(), String> {
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
        .find(&me)
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
    import_ai_user_profile(ctx, tables)?;
    import_conversation(ctx, tables)?;
    import_conversation_participant(ctx, tables)?;
    import_conversation_message(ctx, tables)?;
    import_extension_manifest(ctx, tables)?;
    import_installed_extension(ctx, tables)?;
    import_orcha_agent(ctx, tables)?;
    import_orcha_job(ctx, tables)?;
    import_orcha_task(ctx, tables)?;
    import_orcha_shared_context(ctx, tables)?;

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
    let mut rows: Vec<Page> = arr.iter().map(|r| decode_page(r)).collect::<Result<_, _>>()?;
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
        ctx.db.database_schema().insert(decode_database_schema(row)?);
    }
    Ok(())
}

fn import_property_definition(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("property_definition").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.property_definition().insert(decode_property_definition(row)?);
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
        ctx.db.page_property_value().insert(decode_page_property_value(row)?);
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
        // pear-cloud lifecycle endpoints — minted Identities aren't recoverable
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
    let Some(arr) = tables.get("conversation_message").and_then(|v| v.as_array()) else {
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
        ctx.db.extension_manifest().insert(decode_extension_manifest(row)?);
    }
    Ok(())
}

fn import_installed_extension(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("installed_extension").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.installed_extension().insert(decode_installed_extension(row)?);
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
    let Some(arr) = tables.get("orcha_shared_context").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.orcha_shared_context().insert(decode_orcha_shared_context(row)?);
    }
    Ok(())
}

// ── Decoders (camelCase + __pear tagged values from client) ───────────────────

fn obj<'a>(v: &'a Value, ctx: &str) -> Result<&'a serde_json::Map<String, Value>, String> {
    v.as_object()
        .ok_or_else(|| format!("{ctx}: expected object"))
}

fn u64_at(m: &serde_json::Map<String, Value>, key: &str) -> Result<u64, String> {
    decode_u64(m.get(key).ok_or_else(|| format!("missing {key}"))?)
}

fn opt_u64_at(m: &serde_json::Map<String, Value>, key: &str) -> Result<Option<u64>, String> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(decode_u64(v)?)),
    }
}

fn string_at(m: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    m.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing or invalid string {key}"))
}

fn opt_string_at(m: &serde_json::Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_str()
            .map(|s| Some(s.to_string()))
            .ok_or_else(|| format!("invalid optional string {key}")),
    }
}

fn bool_at(m: &serde_json::Map<String, Value>, key: &str) -> Result<bool, String> {
    m.get(key)
        .and_then(|v| v.as_bool())
        .ok_or_else(|| format!("missing bool {key}"))
}

fn decode_u64(v: &Value) -> Result<u64, String> {
    if let Some(n) = v.as_u64() {
        return Ok(n);
    }
    if let Some(s) = v.as_str() {
        return s.parse().map_err(|e| format!("u64: {e}"));
    }
    if let Some(o) = v.as_object() {
        if o.get("__pear").and_then(|x| x.as_str()) == Some("bigint") {
            let s = o
                .get("v")
                .and_then(|x| x.as_str())
                .ok_or("bigint.v")?;
            return s.parse().map_err(|e| format!("bigint: {e}"));
        }
    }
    Err("expected u64".into())
}

fn decode_i64(v: &Value) -> Result<i64, String> {
    if let Some(n) = v.as_i64() {
        return Ok(n);
    }
    if let Some(n) = v.as_u64() {
        return Ok(n as i64);
    }
    if let Some(s) = v.as_str() {
        return s.parse().map_err(|e| format!("i64: {e}"));
    }
    if let Some(o) = v.as_object() {
        if o.get("__pear").and_then(|x| x.as_str()) == Some("bigint") {
            let s = o.get("v").and_then(|x| x.as_str()).ok_or("bigint.v")?;
            return s.parse().map_err(|e| format!("bigint: {e}"));
        }
    }
    Err("expected i64".into())
}

fn decode_identity(v: &Value) -> Result<Identity, String> {
    if let Some(o) = v.as_object() {
        if o.get("__pear").and_then(|x| x.as_str()) == Some("identity") {
            let hex_str = o.get("v").and_then(|x| x.as_str()).ok_or("identity.v")?;
            return identity_from_hex(hex_str);
        }
    }
    Err("expected identity".into())
}

fn identity_from_hex(hex_str: &str) -> Result<Identity, String> {
    let bytes = hex::decode(hex_str.trim()).map_err(|e| format!("identity hex: {e}"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "identity must be 32 bytes")?;
    Ok(Identity::from_byte_array(arr))
}

fn decode_timestamp(v: &Value) -> Result<Timestamp, String> {
    if let Some(o) = v.as_object() {
        if o.get("__pear").and_then(|x| x.as_str()) == Some("timestamp") {
            let micros = decode_i64(o.get("v").ok_or("timestamp.v")?)?;
            return Ok(Timestamp::from_micros_since_unix_epoch(micros));
        }
        if let Some(m) = o.get("microsSinceUnixEpoch") {
            return Ok(Timestamp::from_micros_since_unix_epoch(decode_i64(m)?));
        }
    }
    Err("expected timestamp".into())
}

fn opt_timestamp_at(
    m: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<Timestamp>, String> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(decode_timestamp(v)?)),
    }
}

fn decode_bytes(v: &Value) -> Result<Vec<u8>, String> {
    if let Some(o) = v.as_object() {
        if o.get("__pear").and_then(|x| x.as_str()) == Some("bytes") {
            let b64 = o.get("v").and_then(|x| x.as_str()).ok_or("bytes.v")?;
            return base64_decode(b64);
        }
    }
    Err("expected bytes".into())
}

fn base64_decode(b64: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("base64: {e}"))
}

fn decode_user(v: &Value) -> Result<User, String> {
    let m = obj(v, "user")?;
    Ok(User {
        identity: decode_identity(m.get("identity").ok_or("identity")?)?,
        name: string_at(m, "name")?,
        email: string_at(m, "email")?,
        is_authenticated: bool_at(m, "isAuthenticated")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        last_seen_at: decode_timestamp(m.get("lastSeenAt").ok_or("lastSeenAt")?)?,
    })
}

fn decode_page(v: &Value) -> Result<Page, String> {
    let m = obj(v, "page")?;
    Ok(Page {
        id: u64_at(m, "id")?,
        parent_id: opt_u64_at(m, "parentId")?,
        page_type: decode_page_type(m.get("pageType").ok_or("pageType")?)?,
        title: string_at(m, "title")?,
        sort_order: u64_at(m, "sortOrder")? as u32,
        embedding: decode_opt_f32_vec(m.get("embedding"))?,
        created_by: decode_actor_type(m.get("createdBy").ok_or("createdBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
        deleted_at: opt_timestamp_at(m, "deletedAt")?,
        icon: opt_string_at(m, "icon")?,
    })
}

fn decode_opt_f32_vec(v: Option<&Value>) -> Result<Option<Vec<f32>>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(a)) => {
            let mut out = Vec::with_capacity(a.len());
            for x in a {
                out.push(
                    x.as_f64()
                        .ok_or("f32")?
                        as f32,
                );
            }
            Ok(Some(out))
        }
        _ => Err("embedding: expected array or null".into()),
    }
}

fn decode_page_type(v: &Value) -> Result<PageType, String> {
    decode_enum_tag2(
        v,
        &[("Doc", PageType::Doc), ("Database", PageType::Database)],
        "PageType",
    )
}

fn decode_actor_type(v: &Value) -> Result<ActorType, String> {
    if let Some(s) = v.as_str() {
        return match s {
            "Human" => Ok(ActorType::Human),
            _ => Err(format!("ActorType: {s}")),
        };
    }
    let o = v.as_object().ok_or("ActorType")?;
    let tag = o
        .get("tag")
        .and_then(|t| t.as_str())
        .ok_or("ActorType.tag")?;
    match tag {
        "Human" => Ok(ActorType::Human),
        "Agent" => {
            let inner = o
                .get("value")
                .or_else(|| o.get("agent"))
                .and_then(|x| x.as_str())
                .ok_or("Agent.value")?;
            Ok(ActorType::Agent(inner.to_string()))
        }
        _ => Err(format!("ActorType::{tag}")),
    }
}

fn decode_page_content(v: &Value) -> Result<PageContent, String> {
    let m = obj(v, "page_content")?;
    Ok(PageContent {
        page_id: u64_at(m, "pageId")?,
        content: string_at(m, "content")?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

fn decode_page_yjs_state(v: &Value) -> Result<PageYjsState, String> {
    let m = obj(v, "page_yjs_state")?;
    Ok(PageYjsState {
        page_id: u64_at(m, "pageId")?,
        data: decode_bytes(m.get("data").ok_or("data")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

fn decode_database_schema(v: &Value) -> Result<DatabaseSchema, String> {
    let m = obj(v, "database_schema")?;
    Ok(DatabaseSchema {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        name: string_at(m, "name")?,
        config: opt_string_at(m, "config")?,
    })
}

fn decode_property_definition(v: &Value) -> Result<PropertyDefinition, String> {
    let m = obj(v, "property_definition")?;
    Ok(PropertyDefinition {
        id: u64_at(m, "id")?,
        schema_id: u64_at(m, "schemaId")?,
        name: string_at(m, "name")?,
        property_type: decode_property_type(m.get("propertyType").ok_or("propertyType")?)?,
        config: string_at(m, "config")?,
        order: u64_at(m, "order")? as u32,
    })
}

fn decode_property_type(v: &Value) -> Result<PropertyType, String> {
    let o = v.as_object().ok_or("PropertyType")?;
    let tag = o
        .get("tag")
        .and_then(|t| t.as_str())
        .ok_or("PropertyType.tag")?;
    match tag {
        "Text" => Ok(PropertyType::Text),
        "Number" => Ok(PropertyType::Number),
        "Date" => Ok(PropertyType::Date),
        "Select" => Ok(PropertyType::Select),
        "MultiSelect" => Ok(PropertyType::MultiSelect),
        "Relation" => Ok(PropertyType::Relation),
        "Checkbox" => Ok(PropertyType::Checkbox),
        "Url" => Ok(PropertyType::Url),
        "Person" => Ok(PropertyType::Person),
        _ => Err(format!("PropertyType::{tag}")),
    }
}

fn decode_database_view(v: &Value) -> Result<DatabaseView, String> {
    let m = obj(v, "database_view")?;
    Ok(DatabaseView {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        name: string_at(m, "name")?,
        view_type: decode_view_type(m.get("viewType").ok_or("viewType")?)?,
        config: string_at(m, "config")?,
        is_default: bool_at(m, "isDefault")?,
        owner_identity: opt_string_at(m, "ownerIdentity")?,
        created_by: decode_actor_type(m.get("createdBy").ok_or("createdBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

fn decode_view_type(v: &Value) -> Result<ViewType, String> {
    decode_enum_tag2(
        v,
        &[
            ("Grid", ViewType::Grid),
            ("List", ViewType::List),
            ("Kanban", ViewType::Kanban),
            ("Calendar", ViewType::Calendar),
            ("Gallery", ViewType::Gallery),
        ],
        "ViewType",
    )
}

fn decode_page_property_value(v: &Value) -> Result<PagePropertyValue, String> {
    let m = obj(v, "page_property_value")?;
    Ok(PagePropertyValue {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        property_definition_id: u64_at(m, "propertyDefinitionId")?,
        value: decode_property_value(m.get("value").ok_or("value")?)?,
    })
}

fn decode_page_property_value_history(v: &Value) -> Result<PagePropertyValueHistory, String> {
    let m = obj(v, "page_property_value_history")?;
    Ok(PagePropertyValueHistory {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        property_definition_id: u64_at(m, "propertyDefinitionId")?,
        value: decode_property_value(m.get("value").ok_or("value")?)?,
        is_current: bool_at(m, "isCurrent")?,
        changed_at: decode_timestamp(m.get("changedAt").ok_or("changedAt")?)?,
        changed_by: decode_actor_type(m.get("changedBy").ok_or("changedBy")?)?,
    })
}

fn decode_page_snapshot(v: &Value) -> Result<PageSnapshot, String> {
    let m = obj(v, "page_snapshot")?;
    Ok(PageSnapshot {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        title: string_at(m, "title")?,
        content: string_at(m, "content")?,
        snapshot_at: decode_timestamp(m.get("snapshotAt").ok_or("snapshotAt")?)?,
        created_by: decode_actor_type(m.get("createdBy").ok_or("createdBy")?)?,
        snapshot_type: decode_snapshot_type(m.get("snapshotType").ok_or("snapshotType")?)?,
    })
}

fn decode_snapshot_type(v: &Value) -> Result<SnapshotType, String> {
    decode_enum_tag2(
        v,
        &[
            ("Manual", SnapshotType::Manual),
            ("Periodic", SnapshotType::Periodic),
            ("PreAgentEdit", SnapshotType::PreAgentEdit),
            ("PostAgentEdit", SnapshotType::PostAgentEdit),
        ],
        "SnapshotType",
    )
}

fn decode_attachment(v: &Value) -> Result<Attachment, String> {
    let m = obj(v, "attachment")?;
    Ok(Attachment {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        filename: string_at(m, "filename")?,
        content_type: string_at(m, "contentType")?,
        storage_key: string_at(m, "storageKey")?,
        size_bytes: u64_at(m, "sizeBytes")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
    })
}

fn decode_ai_user_profile(v: &Value) -> Result<AiUserProfile, String> {
    let m = obj(v, "ai_user_profile")?;
    Ok(AiUserProfile {
        ai_user_id: u64_at(m, "aiUserId")?,
        identity: decode_identity(m.get("identity").ok_or("identity")?)?,
        display_name: string_at(m, "displayName")?,
        avatar_url: opt_string_at(m, "avatarUrl")?,
        provider_name: string_at(m, "providerName")?,
        model_name: string_at(m, "modelName")?,
        // hasApiKey is informational only — fall back to false when absent so
        // older snapshots can still decode (the operator must reconfigure keys
        // post-import anyway).
        has_api_key: m.get("hasApiKey").and_then(|v| v.as_bool()).unwrap_or(false),
        created_by: decode_identity(m.get("createdBy").ok_or("createdBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
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
    })
}

fn decode_conversation_participant(v: &Value) -> Result<ConversationParticipant, String> {
    let m = obj(v, "conversation_participant")?;
    Ok(ConversationParticipant {
        id: u64_at(m, "id")?,
        conversation_id: u64_at(m, "conversationId")?,
        identity: decode_identity(m.get("identity").ok_or("identity")?)?,
        role: decode_participant_role(m.get("role").ok_or("role")?)?,
        joined_at: decode_timestamp(m.get("joinedAt").ok_or("joinedAt")?)?,
    })
}

fn decode_participant_role(v: &Value) -> Result<ParticipantRole, String> {
    decode_enum_tag2(
        v,
        &[
            ("Initiator", ParticipantRole::Initiator),
            ("Member", ParticipantRole::Member),
        ],
        "ParticipantRole",
    )
}

fn decode_conversation_status(v: &Value) -> Result<ConversationStatus, String> {
    decode_enum_tag2(
        v,
        &[
            ("Active", ConversationStatus::Active),
            ("Closed", ConversationStatus::Closed),
        ],
        "ConversationStatus",
    )
}

fn decode_conversation_message(v: &Value) -> Result<ConversationMessage, String> {
    let m = obj(v, "conversation_message")?;
    Ok(ConversationMessage {
        id: u64_at(m, "id")?,
        conversation_id: u64_at(m, "conversationId")?,
        sender: decode_message_sender(m.get("sender").ok_or("sender")?)?,
        content: string_at(m, "content")?,
        job_id: opt_u64_at(m, "jobId")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        status: decode_message_status(m.get("status").ok_or("status")?)?,
        thinking: opt_string_at(m, "thinking")?,
        tool_calls_json: opt_string_at(m, "toolCallsJson")?,
        input_tokens: u64_at(m, "inputTokens")? as u32,
        output_tokens: u64_at(m, "outputTokens")? as u32,
        cache_creation_input_tokens: u64_at(m, "cacheCreationInputTokens")? as u32,
        cache_read_input_tokens: u64_at(m, "cacheReadInputTokens")? as u32,
    })
}

fn decode_message_status(v: &Value) -> Result<MessageStatus, String> {
    decode_enum_tag2(
        v,
        &[
            ("Complete", MessageStatus::Complete),
            ("Thinking", MessageStatus::Thinking),
            ("ToolUse", MessageStatus::ToolUse),
            ("Streaming", MessageStatus::Streaming),
            ("Error", MessageStatus::Error),
        ],
        "MessageStatus",
    )
}

fn decode_message_sender(v: &Value) -> Result<MessageSender, String> {
    let o = v.as_object().ok_or("MessageSender")?;
    let tag = o
        .get("tag")
        .and_then(|t| t.as_str())
        .ok_or("MessageSender.tag")?;
    match tag {
        "User" => Ok(MessageSender::User(decode_identity(
            o.get("value").ok_or("User.identity")?,
        )?)),
        "System" => Ok(MessageSender::System(string_at(o, "value")?)),
        // Legacy v1 snapshots distinguished Human(Identity) and AiUser(u64);
        // accept Human here for forward compat but reject AiUser since we have
        // no way to recover the AI user's Identity from just the legacy id.
        "Human" => Ok(MessageSender::User(decode_identity(
            o.get("value").ok_or("Human.identity")?,
        )?)),
        "AiUser" => Err(
            "Legacy AiUser(u64) sender is not migratable: re-export the snapshot from an upgraded \
             Pear version that emits AI user Identities."
                .to_string(),
        ),
        _ => Err(format!("MessageSender::{tag}")),
    }
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

fn decode_installed_extension(v: &Value) -> Result<InstalledExtension, String> {
    let m = obj(v, "installed_extension")?;
    Ok(InstalledExtension {
        id: u64_at(m, "id")?,
        manifest_id: u64_at(m, "manifestId")?,
        installed_by: decode_identity(m.get("installedBy").ok_or("installedBy")?)?,
        install_status: decode_install_status(m.get("installStatus").ok_or("installStatus")?)?,
        ai_user_id: opt_u64_at(m, "aiUserId")?,
        mcp_server_id: opt_u64_at(m, "mcpServerId")?,
        enabled: bool_at(m, "enabled")?,
        installed_at: decode_timestamp(m.get("installedAt").ok_or("installedAt")?)?,
        confirmed_at: opt_timestamp_at(m, "confirmedAt")?,
    })
}

fn decode_install_status(v: &Value) -> Result<crate::InstallStatus, String> {
    let o = v.as_object().ok_or("InstallStatus")?;
    let tag = o
        .get("tag")
        .and_then(|t| t.as_str())
        .ok_or("InstallStatus.tag")?;
    match tag {
        "PendingConfirmation" => Ok(crate::InstallStatus::PendingConfirmation),
        "Active" => Ok(crate::InstallStatus::Active),
        _ => Err(format!("InstallStatus::{tag}")),
    }
}

fn decode_orcha_agent(v: &Value) -> Result<OrchaAgent, String> {
    let m = obj(v, "orcha_agent")?;
    Ok(OrchaAgent {
        id: string_at(m, "id")?,
        capabilities: m
            .get("capabilities")
            .and_then(|v| v.as_array())
            .ok_or("capabilities")?
            .iter()
            .map(|x| {
                x.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| "orcha_agent.cap".to_string())
            })
            .collect::<Result<Vec<_>, String>>()?,
        status: string_at(m, "status")?,
    })
}

fn decode_orcha_job(v: &Value) -> Result<OrchaJob, String> {
    let m = obj(v, "orcha_job")?;
    Ok(OrchaJob {
        id: u64_at(m, "id")?,
        user_id: string_at(m, "userId")?,
        prompt: string_at(m, "prompt")?,
        page_id: opt_u64_at(m, "pageId")?,
        status: string_at(m, "status")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
    })
}

fn decode_orcha_task(v: &Value) -> Result<OrchaTask, String> {
    let m = obj(v, "orcha_task")?;
    let deps = m
        .get("dependsOn")
        .and_then(|v| v.as_array())
        .ok_or("dependsOn")?;
    let depends_on: Vec<u64> = deps.iter().map(|x| decode_u64(x)).collect::<Result<_, _>>()?;
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
    })
}

fn decode_orcha_shared_context(v: &Value) -> Result<OrchaSharedContext, String> {
    let m = obj(v, "orcha_shared_context")?;
    Ok(OrchaSharedContext {
        id: u64_at(m, "id")?,
        job_id: u64_at(m, "jobId")?,
        key: string_at(m, "key")?,
        value: string_at(m, "value")?,
        created_by: string_at(m, "createdBy")?,
    })
}

fn decode_enum_tag2<T: Clone>(
    v: &Value,
    variants: &[(&str, T)],
    _name: &str,
) -> Result<T, String> {
    if let Some(s) = v.as_str() {
        for (k, t) in variants {
            if *k == s {
                return Ok(t.clone());
            }
        }
    }
    if let Some(o) = v.as_object() {
        let tag = o.get("tag").and_then(|t| t.as_str());
        if let Some(tag) = tag {
            for (k, t) in variants {
                if *k == tag {
                    return Ok(t.clone());
                }
            }
        }
    }
    Err("unknown enum variant".into())
}

fn decode_property_value(v: &Value) -> Result<PropertyValue, String> {
    let o = v.as_object().ok_or("PropertyValue")?;
    let tag = o
        .get("tag")
        .and_then(|t| t.as_str())
        .ok_or("PropertyValue.tag")?;
    match tag {
        "Text" => Ok(PropertyValue::Text(string_at(o, "value")?)),
        "Number" => Ok(PropertyValue::Number(
            o.get("value")
                .and_then(|x| x.as_f64())
                .ok_or("Number")?,
        )),
        "Date" => Ok(PropertyValue::Date(u64_at(o, "value")?)),
        "Select" => Ok(PropertyValue::Select(string_at(o, "value")?)),
        "MultiSelect" => {
            let arr = o.get("value").and_then(|v| v.as_array()).ok_or("MultiSelect")?;
            let mut xs = Vec::new();
            for x in arr {
                xs.push(x.as_str().ok_or("ms")?.to_string());
            }
            Ok(PropertyValue::MultiSelect(xs))
        }
        "Relation" => {
            let arr = o.get("value").and_then(|v| v.as_array()).ok_or("Relation")?;
            let mut xs = Vec::new();
            for x in arr {
                xs.push(decode_u64(x)?);
            }
            Ok(PropertyValue::Relation(xs))
        }
        "Checkbox" => Ok(PropertyValue::Checkbox(
            o.get("value")
                .and_then(|x| x.as_bool())
                .ok_or("Checkbox.value")?,
        )),
        "Url" => Ok(PropertyValue::Url(string_at(o, "value")?)),
        "Person" => {
            let arr = o.get("value").and_then(|v| v.as_array()).ok_or("Person")?;
            let mut xs = Vec::new();
            for x in arr {
                xs.push(x.as_str().ok_or("person id")?.to_string());
            }
            Ok(PropertyValue::Person(xs))
        }
        _ => Err(format!("PropertyValue::{tag}")),
    }
}
