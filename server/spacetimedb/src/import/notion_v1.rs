//! Import [`notion-import-v1`] JSON produced by the Pear Cloud import orchestration route.
//!
//! Accepts content fetched from the Notion API and transformed into Pear's
//! wire format (same `__pear`-tagged encoding as `pear-snapshot-v1`).
//!
//! Only content tables are imported — no AI users, Orcha jobs, API endpoints,
//! or extensions. This is a content migration, not a full workspace restore.
//!
//! Imports into a **non-empty workspace** are supported: a contiguous id
//! block per table is atomically reserved through the `id_counter` allocator
//! (advancing the counter past the block, so every other allocation path
//! skips it), every payload id (the transformer numbers from 1) is shifted
//! into its table's reserved block, cross-references (parents, relations,
//! schema/property links, conversations, content page links) are remapped
//! with the same bases, and everything lands under a fresh "Notion Import"
//! container page at the workspace root. Reservation — rather than
//! offsetting from observed maxima — keeps the bases valid regardless of
//! concurrent allocations, including across transactions if the apply is
//! ever chunked.

use crate::id_counters::reserve_id_block;
use crate::pages::create_component_tree_page_inner;
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
/// Requires the caller to be an authenticated workspace member. The workspace
/// may already have content: imported ids are offset above current maxima and
/// the imported tree is parented under a fresh "Notion Import" container page.
/// All writes are atomic within this reducer call.
#[reducer]
pub fn import_notion(ctx: &ReducerContext, snapshot_json: String) -> Result<(), String> {
    // Guard: authenticated caller (the background-job path is gated on the
    // module publisher in notion_jobs.rs instead).
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
    apply_notion_snapshot(ctx, &snapshot_json).map(|_| ())
}

/// Job-path entry: same importer, publisher authority already checked by the
/// caller. Returns the container page id for the job row.
pub(crate) fn apply_notion_snapshot_for_job(
    ctx: &ReducerContext,
    snapshot_json: &str,
) -> Result<u64, String> {
    apply_notion_snapshot(ctx, snapshot_json)
}

/// Per-table id-block bases applied to every id in the payload. The
/// transformer numbers each table from 1 and declares its id-space size
/// (`idCounts`); each base comes from an atomic `reserve_id_block`, so
/// `base + payload id` lies inside space no other allocation can touch.
struct Offsets {
    page: u64,
    schema: u64,
    prop_def: u64,
    view: u64,
    prop_value: u64,
    attachment: u64,
    conversation: u64,
    conv_participant: u64,
    conv_message: u64,
    /// Existing root page the imported top-level pages are parented under.
    container: u64,
}

/// Defensive ceiling on the payload — imported content is untrusted input and
/// a single reducer call materialises the whole document in module memory.
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;

fn apply_notion_snapshot(ctx: &ReducerContext, snapshot_json: &str) -> Result<u64, String> {
    if snapshot_json.len() > MAX_SNAPSHOT_BYTES {
        return Err(format!(
            "Import payload is {} bytes; the maximum is {MAX_SNAPSHOT_BYTES}.              Share a smaller selection and retry.",
            snapshot_json.len()
        ));
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

    // Container page first (through the normal allocation path), THEN the
    // offsets — so the container's id sits below every imported id.
    let imported_date = root
        .get("importedAt")
        .and_then(|v| v.as_str())
        .map(|s| s.chars().take(10).collect::<String>())
        .unwrap_or_else(|| "import".to_string());
    // Title the container after the source Notion workspace so imports from
    // multiple workspaces stay distinguishable side by side.
    let container_title = match root
        .get("notionWorkspaceName")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(name) => format!("{name} (Notion) — {imported_date}"),
        None => format!("Notion Import — {imported_date}"),
    };
    let container = create_component_tree_page_inner(
        ctx,
        None,
        PageType::Doc,
        container_title,
        ActorType::Human,
    )?;

    // Reserve a contiguous id block per table through the allocator instead
    // of offsetting from observed maxima: the reservation advances the
    // counter past the block in this transaction, so every other allocation
    // path skips it — and the bases stay valid across transactions, which a
    // max-at-apply-time snapshot would not if the apply is ever chunked.
    let off = Offsets {
        page: reserve_id_block(ctx, "page", id_span(&root, tables, "page")?, || {
            ctx.db.page().iter().map(|r| r.id).max().unwrap_or(0)
        }),
        schema: reserve_id_block(
            ctx,
            "database_schema",
            id_span(&root, tables, "database_schema")?,
            || ctx.db.database_schema().iter().map(|r| r.id).max().unwrap_or(0),
        ),
        prop_def: reserve_id_block(
            ctx,
            "property_definition",
            id_span(&root, tables, "property_definition")?,
            || ctx.db.property_definition().iter().map(|r| r.id).max().unwrap_or(0),
        ),
        view: reserve_id_block(
            ctx,
            "database_view",
            id_span(&root, tables, "database_view")?,
            || ctx.db.database_view().iter().map(|r| r.id).max().unwrap_or(0),
        ),
        prop_value: reserve_id_block(
            ctx,
            "page_property_value",
            id_span(&root, tables, "page_property_value")?,
            || ctx.db.page_property_value().iter().map(|r| r.id).max().unwrap_or(0),
        ),
        attachment: reserve_id_block(
            ctx,
            "attachment",
            id_span(&root, tables, "attachment")?,
            || ctx.db.attachment().iter().map(|r| r.id).max().unwrap_or(0),
        ),
        conversation: reserve_id_block(
            ctx,
            "conversation",
            id_span(&root, tables, "conversation")?,
            || ctx.db.conversation().iter().map(|r| r.id).max().unwrap_or(0),
        ),
        conv_participant: reserve_id_block(
            ctx,
            "conversation_participant",
            id_span(&root, tables, "conversation_participant")?,
            || {
                ctx.db
                    .conversation_participant()
                    .iter()
                    .map(|r| r.id)
                    .max()
                    .unwrap_or(0)
            },
        ),
        conv_message: reserve_id_block(
            ctx,
            "conversation_message",
            id_span(&root, tables, "conversation_message")?,
            || {
                ctx.db
                    .conversation_message()
                    .iter()
                    .map(|r| r.id)
                    .max()
                    .unwrap_or(0)
            },
        ),
        container,
    };

    import_pages(ctx, tables, &off)?;
    import_page_content(ctx, tables, &off)?;
    import_database_schema(ctx, tables, &off)?;
    import_property_definition(ctx, tables, &off)?;
    import_database_view(ctx, tables, &off)?;
    import_page_property_value(ctx, tables, &off)?;
    import_attachment(ctx, tables, &off)?;
    import_conversation(ctx, tables, &off)?;
    import_conversation_participant(ctx, tables, &off)?;
    import_conversation_message(ctx, tables, &off)?;

    Ok(container)
}

/// Defensive ceiling on a single table's reserved id span — the declared
/// counts come from the (untrusted) payload, and an absurd value would burn
/// through the id space or overflow the counter.
const MAX_ID_SPAN: u64 = 50_000_000;

/// Ids the payload occupies in a table's namespace: the transformer-declared
/// count when present, or the maximum row id actually found — whichever is
/// larger. Declared counts also cover ids that were assigned but never
/// materialised as rows (e.g. a link_to_page target outside the export), so
/// dangling references still land inside reserved space.
fn id_span(root: &Value, tables: &Value, table: &str) -> Result<u64, String> {
    let declared = root
        .get("idCounts")
        .and_then(|c| c.get(table))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let row_max = tables
        .get(table)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|row| row.as_object())
                .filter_map(|o| o.get("id"))
                .filter_map(|v| decode_u64(v).ok())
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    let span = declared.max(row_max);
    if span > MAX_ID_SPAN {
        return Err(format!(
            "Import declares {span} ids for table {table}; the maximum is {MAX_ID_SPAN}."
        ));
    }
    Ok(span)
}

// ── Table importers ───────────────────────────────────────────────────────────

fn import_pages(ctx: &ReducerContext, tables: &Value, off: &Offsets) -> Result<(), String> {
    let Some(arr) = tables.get("page").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    let mut rows: Vec<Page> = arr.iter().map(decode_page).collect::<Result<_, _>>()?;
    for p in rows.iter_mut() {
        p.id += off.page;
        // Top-level Notion pages land under the import container; children
        // keep their (offset) parents.
        p.parent_id = Some(p.parent_id.map(|pid| pid + off.page).unwrap_or(off.container));
        p.parent_pk = p.parent_id.unwrap_or(0);
    }
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

fn import_page_content(ctx: &ReducerContext, tables: &Value, off: &Offsets) -> Result<(), String> {
    let Some(arr) = tables.get("page_content").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        let mut r = decode_page_content(row)?;
        r.page_id += off.page;
        r.content = remap_content_page_ids(&r.content, off);
        ctx.db.page_content().insert(r);
    }
    Ok(())
}

/// Remap payload-local page ids embedded in BlockNote content JSON: the
/// `pageId` prop of pageLink blocks and `/workspace/<slug>/<id>` hrefs the
/// transformer generated. Table-row ids are offset on insert, but content is
/// an opaque string to the rest of the import — without this, links point at
/// whichever pre-existing page owns the un-offset id.
fn remap_content_page_ids(content: &str, off: &Offsets) -> String {
    let Ok(mut v) = serde_json::from_str::<Value>(content) else {
        return content.to_string();
    };
    fn walk(v: &mut Value, off: &Offsets) {
        match v {
            Value::Array(items) => items.iter_mut().for_each(|x| walk(x, off)),
            Value::Object(o) => {
                let ty = o.get("type").and_then(|t| t.as_str());
                if ty == Some("pageLink") {
                    if let Some(Value::Object(props)) = o.get_mut("props") {
                        let parsed = props
                            .get("pageId")
                            .and_then(|p| p.as_str())
                            .and_then(|s| s.parse::<u64>().ok());
                        if let Some(id) = parsed {
                            props.insert(
                                "pageId".to_string(),
                                Value::String((id + off.page).to_string()),
                            );
                        }
                    }
                } else if ty == Some("link") {
                    if let Some(href) = o.get("href").and_then(|h| h.as_str()) {
                        if let Some(remapped) = remap_workspace_href(href, off) {
                            o.insert("href".to_string(), Value::String(remapped));
                        }
                    }
                }
                o.values_mut().for_each(|x| walk(x, off));
            }
            _ => {}
        }
    }
    walk(&mut v, off);
    v.to_string()
}

/// `/workspace/<slug>/<digits>` → same path with the page offset applied.
/// Anything else (external URLs, blob paths, deeper paths) is left alone.
fn remap_workspace_href(href: &str, off: &Offsets) -> Option<String> {
    let parts: Vec<&str> = href.split('/').collect();
    match parts.as_slice() {
        ["", "workspace", slug, id] => {
            let id = id.parse::<u64>().ok()?;
            Some(format!("/workspace/{}/{}", slug, id + off.page))
        }
        _ => None,
    }
}

fn import_database_schema(ctx: &ReducerContext, tables: &Value, off: &Offsets) -> Result<(), String> {
    let Some(arr) = tables.get("database_schema").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        let mut r = decode_database_schema(row)?;
        r.id += off.schema;
        r.page_id += off.page;
        ctx.db.database_schema().insert(r);
    }
    Ok(())
}

fn import_property_definition(ctx: &ReducerContext, tables: &Value, off: &Offsets) -> Result<(), String> {
    let Some(arr) = tables.get("property_definition").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        let mut r = decode_property_definition(row)?;
        r.id += off.prop_def;
        r.schema_id += off.schema;
        r.config = remap_relation_config(&r.config, off);
        ctx.db.property_definition().insert(r);
    }
    Ok(())
}

/// Remap the relation target page id embedded in a property-definition config.
/// The transformer historically wrote `targetDatabaseId`; the UI reads
/// `targetPageId` — normalise to the latter while applying the page offset.
fn remap_relation_config(config: &str, off: &Offsets) -> String {
    let Ok(Value::Object(mut o)) = serde_json::from_str::<Value>(config) else {
        return config.to_string();
    };
    let parse = |v: &Value| match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    };
    let target = o
        .get("targetPageId")
        .or_else(|| o.get("targetDatabaseId"))
        .and_then(parse);
    // Only rewrite when the target parses as a payload id; an unparseable
    // value (e.g. a raw Notion UUID from an older transformer) is left alone
    // rather than silently dropped.
    if let Some(t) = target {
        o.remove("targetDatabaseId");
        o.insert(
            "targetPageId".to_string(),
            Value::String((t + off.page).to_string()),
        );
    }
    Value::Object(o).to_string()
}

fn import_database_view(ctx: &ReducerContext, tables: &Value, off: &Offsets) -> Result<(), String> {
    let Some(arr) = tables.get("database_view").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        let mut r = decode_database_view(row)?;
        r.id += off.view;
        r.page_id += off.page;
        ctx.db.database_view().insert(r);
    }
    Ok(())
}

fn import_page_property_value(ctx: &ReducerContext, tables: &Value, off: &Offsets) -> Result<(), String> {
    let Some(arr) = tables.get("page_property_value").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        let mut r = decode_page_property_value(row)?;
        r.id += off.prop_value;
        r.page_id += off.page;
        r.property_definition_id += off.prop_def;
        if let PropertyValue::Relation(ids) = &mut r.value {
            for id in ids.iter_mut() {
                *id += off.page;
            }
        }
        ctx.db.page_property_value().insert(r);
    }
    Ok(())
}

fn import_attachment(ctx: &ReducerContext, tables: &Value, off: &Offsets) -> Result<(), String> {
    let Some(arr) = tables.get("attachment").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        let mut r = decode_attachment(row)?;
        r.id += off.attachment;
        r.page_id += off.page;
        ctx.db.attachment().insert(r);
    }
    Ok(())
}

fn import_conversation(ctx: &ReducerContext, tables: &Value, off: &Offsets) -> Result<(), String> {
    let Some(arr) = tables.get("conversation").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for row in arr {
        let mut r = decode_conversation(row)?;
        r.id += off.conversation;
        r.page_id = r.page_id.map(|p| p + off.page);
        ctx.db.conversation().insert(r);
    }
    Ok(())
}

fn import_conversation_participant(ctx: &ReducerContext, tables: &Value, off: &Offsets) -> Result<(), String> {
    let Some(arr) = tables
        .get("conversation_participant")
        .and_then(|v| v.as_array())
    else {
        return Ok(());
    };
    for row in arr {
        let mut r = decode_conversation_participant(row)?;
        r.id += off.conv_participant;
        r.conversation_id += off.conversation;
        ctx.db.conversation_participant().insert(r);
    }
    Ok(())
}

fn import_conversation_message(ctx: &ReducerContext, tables: &Value, off: &Offsets) -> Result<(), String> {
    let Some(arr) = tables
        .get("conversation_message")
        .and_then(|v| v.as_array())
    else {
        return Ok(());
    };
    for row in arr {
        let mut r = decode_conversation_message(row)?;
        r.id += off.conv_message;
        r.conversation_id += off.conversation;
        r.linked_conversation_id = r.linked_conversation_id.map(|c| c + off.conversation);
        ctx.db.conversation_message().insert(r);
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
        // Notion has no schema inheritance — imported schemas are roots.
        parent_schema_id: None,
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
        // Values for these are computed client-side from the stored config;
        // the transformer emits the definitions but no stored values.
        "Formula" => Ok(PropertyType::Formula),
        "Rollup" => Ok(PropertyType::Rollup),
        "File" => Ok(PropertyType::File),
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
        "File" => {
            let arr = o
                .get("value")
                .and_then(|v| v.as_array())
                .ok_or("File.value")?;
            let refs = arr
                .iter()
                .map(|f| {
                    let m = f.as_object().ok_or("File entry")?;
                    Ok(crate::FileRef {
                        name: m
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("file")
                            .to_string(),
                        object_id: m
                            .get("objectId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        external_url: m
                            .get("externalUrl")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(PropertyValue::File(refs))
        }
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
        model_override: None,
        effort_override: None,
        resolved_by: None,
        resolved_at: None,
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
        timeline_json: opt_string_at(m, "timelineJson")?,
        input_tokens: u64_at(m, "inputTokens")? as u32,
        output_tokens: u64_at(m, "outputTokens")? as u32,
        cache_creation_input_tokens: u64_at(m, "cacheCreationInputTokens")? as u32,
        cache_read_input_tokens: u64_at(m, "cacheReadInputTokens")? as u32,
        linked_conversation_id: opt_u64_at(m, "linkedConversationId")?,
        component_tree_json: opt_string_at(m, "componentTreeJson")?,
        mentions: None,
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

#[cfg(test)]
mod notion_v1_tests {
    use super::*;

    fn offsets(page: u64) -> Offsets {
        Offsets {
            page,
            schema: 0,
            prop_def: 0,
            view: 0,
            prop_value: 0,
            attachment: 0,
            conversation: 0,
            conv_participant: 0,
            conv_message: 0,
            container: 1,
        }
    }

    #[test]
    fn remap_relation_config_offsets_and_normalises_target_key() {
        let off = offsets(500);
        // Legacy transformer key, numeric value.
        let out = remap_relation_config(r#"{"targetDatabaseId":3}"#, &off);
        assert_eq!(out, r#"{"targetPageId":"503"}"#);
        // Canonical key, string value; other keys survive.
        let out = remap_relation_config(r#"{"options":["A"],"targetPageId":"7"}"#, &off);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["targetPageId"], "507");
        assert_eq!(v["options"][0], "A");
        // No target key → untouched shape, still valid JSON.
        let out = remap_relation_config(r#"{"options":["A","B"]}"#, &off);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("targetPageId").is_none());
        // Non-object config passes through verbatim.
        assert_eq!(remap_relation_config("not json", &off), "not json");
    }

    #[test]
    fn id_span_takes_max_of_declared_and_row_ids_and_caps() {
        let tables = serde_json::json!({
            "page": [
                {"id": {"__pear": "bigint", "v": "3"}},
                {"id": {"__pear": "bigint", "v": "9"}},
            ],
        });
        // Declared count wins when larger (covers dangling link targets).
        let root = serde_json::json!({"idCounts": {"page": 12}});
        assert_eq!(id_span(&root, &tables, "page").unwrap(), 12);
        // Row max wins when the declaration is missing or lower.
        let root = serde_json::json!({"idCounts": {"page": 4}});
        assert_eq!(id_span(&root, &tables, "page").unwrap(), 9);
        assert_eq!(id_span(&serde_json::json!({}), &tables, "page").unwrap(), 9);
        // Absent table → zero-width reservation.
        assert_eq!(id_span(&serde_json::json!({}), &tables, "attachment").unwrap(), 0);
        // Untrusted declared counts are capped.
        let root = serde_json::json!({"idCounts": {"page": u64::MAX}});
        assert!(id_span(&root, &tables, "page").is_err());
    }

    #[test]
    fn remap_content_page_ids_covers_page_links_and_hrefs() {
        let off = offsets(500);
        // pageLink block props remap; nested children are walked too.
        let content = r#"[{"id":"a","type":"pageLink","props":{"pageId":"40","pageTitle":"Recipes"},"content":[],"children":[{"id":"b","type":"pageLink","props":{"pageId":"7","pageTitle":"Sub"},"content":[],"children":[]}]}]"#;
        let out = remap_content_page_ids(content, &off);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v[0]["props"]["pageId"], "540");
        assert_eq!(v[0]["children"][0]["props"]["pageId"], "507");

        // Inline workspace links remap; external and blob URLs are untouched.
        let content = r#"[{"id":"c","type":"paragraph","props":{},"content":[{"type":"link","href":"/workspace/eclosion/40","content":[{"type":"text","text":"→ Hub","styles":{}}]},{"type":"link","href":"https://example.com/workspace/eclosion/40","content":[]},{"type":"link","href":"/api/workspaces/eclosion/blobs/abc/raw","content":[]}],"children":[]}]"#;
        let out = remap_content_page_ids(content, &off);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v[0]["content"][0]["href"], "/workspace/eclosion/540");
        assert_eq!(
            v[0]["content"][1]["href"],
            "https://example.com/workspace/eclosion/40"
        );
        assert_eq!(
            v[0]["content"][2]["href"],
            "/api/workspaces/eclosion/blobs/abc/raw"
        );

        // Non-JSON content passes through verbatim.
        assert_eq!(remap_content_page_ids("not json", &off), "not json");
    }

    #[test]
    fn decode_property_type_accepts_formula_and_rollup() {
        let v = serde_json::json!({"tag": "Formula"});
        assert_eq!(decode_property_type(&v).unwrap(), PropertyType::Formula);
        let v = serde_json::json!({"tag": "Rollup"});
        assert_eq!(decode_property_type(&v).unwrap(), PropertyType::Rollup);
        let v = serde_json::json!({"tag": "Nope"});
        assert!(decode_property_type(&v).is_err());
    }
}
