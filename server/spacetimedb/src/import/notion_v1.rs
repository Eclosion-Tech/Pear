//! Import [`notion-import-v1`] JSON produced by the Pear Cloud import orchestration route.
//!
//! Accepts content fetched from the Notion API and transformed into Pear's
//! wire format (same `__pear`-tagged encoding as `pear-snapshot-v1`).
//!
//! Only content tables are imported — no AI users, Orcha jobs, API endpoints,
//! or extensions. This is a content migration, not a full workspace restore.
//!
//! **v1 limitation:** Requires an empty workspace (no existing pages).
//! Import into a workspace with existing content is not yet supported.

use crate::{
    attachment, conversation, conversation_message, conversation_participant, database_schema,
    database_view, page, page_content, page_property_value, property_definition, user,
};
use crate::{
    ActorType, Attachment, Conversation, ConversationKind, ConversationMessage, ConversationParticipant,
    ConversationStatus, ConversationVisibility, DatabaseSchema, DatabaseView, MessageSender,
    MessageStatus, Page, PageContent, PageContentFormat, PagePropertyValue, PageType,
    ParticipantRole, PropertyDefinition, PropertyType, PropertyValue, ViewType,
};
use serde_json::Value;
use spacetimedb::{reducer, Identity, ReducerContext, Table, Timestamp};

const FORMAT: &str = "notion-import-v1";

/// Import a `notion-import-v1` JSON payload produced by `/api/workspaces/[slug]/notion/import`.
///
/// Requires the caller to be an authenticated workspace member and the
/// workspace to be empty (no existing pages). All writes are atomic within
/// this reducer call.
#[reducer]
pub fn import_notion(ctx: &ReducerContext, snapshot_json: String) -> Result<(), String> {
    apply_notion_snapshot(ctx, &snapshot_json)
}

fn apply_notion_snapshot(ctx: &ReducerContext, snapshot_json: &str) -> Result<(), String> {
    // Guard: empty workspace only (v1 limitation)
    if ctx.db.page().iter().next().is_some() {
        return Err("Import refused: workspace already has pages. \
             Use a freshly created workspace for Notion import."
            .to_string());
    }

    // Guard: authenticated caller
    let me = ctx.sender();
    let ok = ctx
        .db
        .user()
        .identity()
        .find(me)
        .map(|u| u.is_authenticated)
        .unwrap_or(false);
    if !ok {
        return Err("You must be logged in to import from Notion.".to_string());
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

    import_pages(ctx, tables)?;
    import_page_content(ctx, tables)?;
    import_database_schema(ctx, tables)?;
    import_property_definition(ctx, tables)?;
    import_database_view(ctx, tables)?;
    import_page_property_value(ctx, tables)?;
    import_attachment(ctx, tables)?;
    import_conversation(ctx, tables)?;
    import_conversation_participant(ctx, tables)?;
    import_conversation_message(ctx, tables)?;

    Ok(())
}

// ── Table importers ───────────────────────────────────────────────────────────

fn import_pages(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("page").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    let mut rows: Vec<Page> = arr.iter().map(decode_page).collect::<Result<_, _>>()?;
    // Insert parents before children (same topological-sort loop as pear_v1)
    rows.sort_by_key(|p| p.id);
    let mut remaining = rows;
    let mut safety = remaining.len() + 1;
    while !remaining.is_empty() {
        if safety == 0 {
            return Err("page parent_id cycle or missing parent in notion payload".into());
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

fn import_attachment(ctx: &ReducerContext, tables: &Value) -> Result<(), String> {
    let Some(arr) = tables.get("attachment").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        ctx.db.attachment().insert(decode_attachment(row)?);
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

// ── Decoders (identical wire format to pear_v1 __pear-tagged values) ──────────

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

fn bool_at_or(m: &serde_json::Map<String, Value>, key: &str, default: bool) -> bool {
    m.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
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

fn decode_u64(v: &Value) -> Result<u64, String> {
    if let Some(n) = v.as_u64() {
        return Ok(n);
    }
    if let Some(s) = v.as_str() {
        return s.parse().map_err(|e| format!("u64: {e}"));
    }
    if let Some(o) = v.as_object() {
        if o.get("__pear").and_then(|x| x.as_str()) == Some("bigint") {
            let s = o.get("v").and_then(|x| x.as_str()).ok_or("bigint.v")?;
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
    let arr: [u8; 32] = bytes.try_into().map_err(|_| "identity must be 32 bytes")?;
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

fn decode_enum_tag<T: Clone>(v: &Value, variants: &[(&str, T)], ctx: &str) -> Result<T, String> {
    let tag = if let Some(s) = v.as_str() {
        s.to_string()
    } else if let Some(o) = v.as_object() {
        o.get("tag")
            .and_then(|t| t.as_str())
            .ok_or_else(|| format!("{ctx}: missing tag"))?
            .to_string()
    } else {
        return Err(format!("{ctx}: expected string or object"));
    };
    for (name, variant) in variants {
        if *name == tag {
            return Ok(variant.clone());
        }
    }
    Err(format!("{ctx}::{tag} unrecognised"))
}

fn decode_page(v: &Value) -> Result<Page, String> {
    let m = obj(v, "page")?;
    let parent_id = opt_u64_at(m, "parentId")?;
    Ok(Page {
        id: u64_at(m, "id")?,
        parent_id,
        page_type: decode_enum_tag(
            m.get("pageType").ok_or("pageType")?,
            &[("Doc", PageType::Doc), ("Database", PageType::Database)],
            "PageType",
        )?,
        title: string_at(m, "title")?,
        sort_order: u64_at(m, "sortOrder")? as u32,
        embedding: None,
        created_by: decode_actor_type(m.get("createdBy").ok_or("createdBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
        deleted_at: opt_timestamp_at(m, "deletedAt")?,
        icon: opt_string_at(m, "icon")?,
        parent_pk: parent_id.unwrap_or(0),
        is_hidden: bool_at_or(m, "isHidden", false),
        // Notion imports always produce BlockNote-format content (the
        // converter writes BlockNote JSON to PageContent.content).
        content_format: PageContentFormat::BlockNote,
    })
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
        view_type: decode_enum_tag(
            m.get("viewType").ok_or("viewType")?,
            &[
                ("Grid", ViewType::Grid),
                ("List", ViewType::List),
                ("Kanban", ViewType::Kanban),
                ("Calendar", ViewType::Calendar),
                ("Gallery", ViewType::Gallery),
            ],
            "ViewType",
        )?,
        config: string_at(m, "config")?,
        is_default: bool_at(m, "isDefault")?,
        owner_identity: opt_string_at(m, "ownerIdentity")?,
        created_by: decode_actor_type(m.get("createdBy").ok_or("createdBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
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
                .ok_or("Number.value")?,
        )),
        "Date" => Ok(PropertyValue::Date(u64_at(o, "value")?)),
        "Select" => Ok(PropertyValue::Select(string_at(o, "value")?)),
        "MultiSelect" => {
            let arr = o
                .get("value")
                .and_then(|v| v.as_array())
                .ok_or("MultiSelect.value")?;
            Ok(PropertyValue::MultiSelect(
                arr.iter()
                    .map(|x| x.as_str().ok_or("ms item").map(str::to_string))
                    .collect::<Result<_, _>>()?,
            ))
        }
        "Relation" => {
            let arr = o
                .get("value")
                .and_then(|v| v.as_array())
                .ok_or("Relation.value")?;
            Ok(PropertyValue::Relation(
                arr.iter().map(decode_u64).collect::<Result<_, _>>()?,
            ))
        }
        "Checkbox" => Ok(PropertyValue::Checkbox(
            o.get("value")
                .and_then(|x| x.as_bool())
                .ok_or("Checkbox.value")?,
        )),
        "Url" => Ok(PropertyValue::Url(string_at(o, "value")?)),
        "Person" => {
            let arr = o
                .get("value")
                .and_then(|v| v.as_array())
                .ok_or("Person.value")?;
            Ok(PropertyValue::Person(
                arr.iter()
                    .map(|x| x.as_str().ok_or("person id").map(str::to_string))
                    .collect::<Result<_, _>>()?,
            ))
        }
        _ => Err(format!("PropertyValue::{tag}")),
    }
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

fn decode_conversation(v: &Value) -> Result<Conversation, String> {
    let m = obj(v, "conversation")?;
    Ok(Conversation {
        id: u64_at(m, "id")?,
        page_id: opt_u64_at(m, "pageId")?,
        initiated_by: decode_identity(m.get("initiatedBy").ok_or("initiatedBy")?)?,
        status: decode_enum_tag(
            m.get("status").ok_or("status")?,
            &[
                ("Active", ConversationStatus::Active),
                ("Closed", ConversationStatus::Closed),
            ],
            "ConversationStatus",
        )?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
        visibility: ConversationVisibility::Private,
        kind: ConversationKind::ContextThread,
        canonical_key: None,
        block_anchor: None,
    })
}

fn decode_conversation_participant(v: &Value) -> Result<ConversationParticipant, String> {
    let m = obj(v, "conversation_participant")?;
    Ok(ConversationParticipant {
        id: u64_at(m, "id")?,
        conversation_id: u64_at(m, "conversationId")?,
        identity: decode_identity(m.get("identity").ok_or("identity")?)?,
        role: decode_enum_tag(
            m.get("role").ok_or("role")?,
            &[
                ("Initiator", ParticipantRole::Initiator),
                ("Member", ParticipantRole::Member),
            ],
            "ParticipantRole",
        )?,
        joined_at: decode_timestamp(m.get("joinedAt").ok_or("joinedAt")?)?,
        last_viewed_message_id: opt_u64_at(m, "lastViewedMessageId")?,
        left_at: opt_timestamp_at(m, "leftAt")?,
    })
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
        status: decode_enum_tag(
            m.get("status").ok_or("status")?,
            &[
                ("Complete", MessageStatus::Complete),
                ("Thinking", MessageStatus::Thinking),
                ("ToolUse", MessageStatus::ToolUse),
                ("Streaming", MessageStatus::Streaming),
                ("Error", MessageStatus::Error),
            ],
            "MessageStatus",
        )?,
        thinking: opt_string_at(m, "thinking")?,
        tool_calls_json: opt_string_at(m, "toolCallsJson")?,
        input_tokens: u64_at(m, "inputTokens")? as u32,
        output_tokens: u64_at(m, "outputTokens")? as u32,
        cache_creation_input_tokens: u64_at(m, "cacheCreationInputTokens")? as u32,
        cache_read_input_tokens: u64_at(m, "cacheReadInputTokens")? as u32,
        linked_conversation_id: opt_u64_at(m, "linkedConversationId")?,
    })
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
        _ => Err(format!("MessageSender::{tag}")),
    }
}
