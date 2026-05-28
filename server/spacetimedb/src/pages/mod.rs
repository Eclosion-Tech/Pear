//! Pages: the universal content atom. Every doc, database row, AI-user
//! memory subtree root — everything — is a `Page`. Companion tables hold
//! mutable content (`PageContent`), the merged Yjs state blob
//! (`PageYjsState`), and per-page attachment metadata (`Attachment`).

use spacetimedb::{reducer, table, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::access_control::helpers::{can_write_page, page_has_any_rule, require_page_write};
use crate::access_control::{next_page_access_rule_id, page_access_rule, PageAccessRule};
use crate::automations::{enqueue_page_created, enqueue_page_deleted, enqueue_page_updated};
use crate::id_counters::alloc_id;
use crate::pages::components::{
    component_node, next_component_node_id, ComponentNode,
};
use crate::pages::schemas::{
    database_schema, page_property_value, page_property_value_history, property_definition,
};
use crate::pages::snapshots::page_snapshot;
use crate::pages::views::database_view;

pub(crate) mod components;
pub(crate) mod schemas;
pub(crate) mod snapshots;
pub(crate) mod views;

pub(crate) use crate::pages::components::PageContentFormat;
pub(crate) use crate::types::ActorType;
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum PageType {
    Doc,
    Database,
}

/// Universal atom — every piece of content is a Page.
/// Content lives separately in PageContent (fetched only when opened).
#[table(accessor = page, public)]
pub struct Page {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub parent_id: Option<u64>,
    pub page_type: PageType,
    pub title: String,
    /// Position within siblings. Spaced by 1000 so insertions rarely need a renumber.
    pub sort_order: u32,
    pub embedding: Option<Vec<f32>>,
    pub created_by: ActorType,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    /// None = active, Some = soft deleted. Hard purge after 30 days.
    pub deleted_at: Option<Timestamp>,
    /// Optional emoji/icon (single character or short string) for sidebar and header.
    #[default(Option::<String>::None)]
    pub icon: Option<String>,
    /// Indexed shadow of `parent_id` with `0` representing root.
    ///
    /// WHY: SpacetimeDB's SQL HTTP subset cannot filter `Option<T>` columns by
    /// literal — `WHERE parent_id = 1` errors with `"The literal expression
    /// '1' cannot be parsed as type '(some: U64 | none: ())'"` (see
    /// clockworklabs/SpacetimeDB#2696, closed wontfix). Custom API endpoint
    /// dispatch needs to scan all rows of a database page (= "child rows of
    /// parent X"), so we mirror `parent_id` into a non-nullable indexed
    /// column that the SQL planner is happy to filter on.
    ///
    /// INVARIANT: every reducer that writes `parent_id` MUST also write
    /// `parent_pk = parent_id.unwrap_or(0)`. The `page_parent_pk_backfill_v1`
    /// migration step (in `run_pending_migrations`) one-shots existing rows
    /// after a deploy.
    ///
    #[index(btree)]
    #[default(0u64)]
    pub parent_pk: u64,
    /// Excludes this page (and conventionally its subtree) from sidebar
    /// navigation and search by default. Used to host AI-user memory
    /// subtrees and other "infrastructure" pages users don't need to see.
    /// Access rules still apply normally — this is a visibility hint, not
    /// a permission.
    #[default(false)]
    pub is_hidden: bool,
    /// Discriminates how this page's content is stored during the BlockNote →
    /// component-tree migration window. `BlockNote` reads from `PageContent`
    /// + `PageYjsState`; `ComponentTree` reads from `ComponentNode` +
    /// `ComponentYjsState`. See `docs/PEAR_COMPONENT_NODE_SCHEMA.md` §
    /// Migration boundary. Becomes vestigial once the migration completes.
    ///
    /// Must be last for schema migration (STDB only allows additive changes
    /// at the end of a struct).
    #[default(PageContentFormat::BlockNote)]
    pub content_format: PageContentFormat,
}

/// Separated from Page so listing/filtering never loads content blobs.
#[table(accessor = page_content, public)]
pub struct PageContent {
    #[primary_key]
    pub page_id: u64,
    pub content: String,
    pub updated_at: Timestamp,
}

/// Single merged Yjs state blob per page.
/// Replaces the old PageYjsUpdate append-only log. Clients write the full
/// Y.encodeStateAsUpdate(doc) here periodically (on blur, on unmount, every ~30s).
/// On fresh load (IndexedDB empty), clients apply this blob to their Y.Doc.
/// IndexedDB (y-indexeddb) is the primary local cache; this is the cross-device
/// sync and backup layer.
#[table(accessor = page_yjs_state, public)]
pub struct PageYjsState {
    #[primary_key]
    pub page_id: u64,
    /// Full merged Yjs state (Y.encodeStateAsUpdate output).
    pub data: Vec<u8>,
    pub updated_at: Timestamp,
}

/// File upload metadata. Blob lives in S3/MinIO at storage_key; this row is the source of truth for "what's attached to this page".
#[table(accessor = attachment, public)]
pub struct Attachment {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub filename: String,
    pub content_type: String,
    /// Key in the S3 bucket (e.g. "pages/123/abc-123.png").
    pub storage_key: String,
    pub size_bytes: u64,
    pub created_at: Timestamp,
}

// ============================================================
// Page Reducers
// ============================================================

pub(crate) fn next_page_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "page", || {
        ctx.db.page().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_attachment_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "attachment", || {
        ctx.db.attachment().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

/// When creating a child of a restricted page, copy access rules so the subtree stays private.
fn copy_page_access_rules_from_parent(ctx: &ReducerContext, parent_id: u64, new_page_id: u64) {
    if !page_has_any_rule(ctx, parent_id) {
        return;
    }
    let rules: Vec<PageAccessRule> = ctx
        .db
        .page_access_rule()
        .page_id()
        .filter(&parent_id)
        .collect();
    for r in rules {
        ctx.db.page_access_rule().insert(PageAccessRule {
            id: next_page_access_rule_id(ctx),
            page_id: new_page_id,
            principal: r.principal.clone(),
            permission: r.permission.clone(),
            granted_by: ctx.sender(),
            granted_at: ctx.timestamp,
        });
    }
}

/// Returns the next sort_order for a new sibling under `parent_id`.
/// Scans all active siblings and returns max_order + 1000.
pub(crate) fn next_sort_order(ctx: &ReducerContext, parent_id: Option<u64>) -> u32 {
    ctx.db
        .page()
        .iter()
        .filter(|p| p.parent_id == parent_id && p.deleted_at.is_none())
        .map(|p| p.sort_order)
        .max()
        .unwrap_or(0)
        + 1000
}

/// Atomically creates a Page. **Doc** pages are created as `ComponentTree`
/// (root `Container` + default `RichText`). **Database** pages keep the
/// legacy `BlockNote` + empty `PageContent` row until database surfaces
/// migrate.
#[reducer]
pub fn create_page(
    ctx: &ReducerContext,
    parent_id: Option<u64>,
    page_type: PageType,
    title: String,
) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("Title cannot be empty".to_string());
    }
    if let Some(pid) = parent_id {
        require_page_write(ctx, pid)?;
    }
    if page_type == PageType::Doc {
        return create_component_tree_page_inner(ctx, parent_id, page_type, title);
    }

    let sort_order = next_sort_order(ctx, parent_id);
    let page = ctx.db.page().insert(Page {
        id: next_page_id(ctx),
        parent_id,
        sort_order,
        page_type,
        title,
        icon: None,
        embedding: None,
        created_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
        parent_pk: parent_id.unwrap_or(0),
        is_hidden: false,
        content_format: PageContentFormat::BlockNote,
    });
    ctx.db.page_content().insert(PageContent {
        page_id: page.id,
        content: String::new(),
        updated_at: ctx.timestamp,
    });
    if let Some(pid) = parent_id {
        copy_page_access_rules_from_parent(ctx, pid, page.id);
    }
    enqueue_page_created(ctx, page.id);
    Ok(())
}

/// Shared body for `create_component_tree_page` and `create_page(Doc)`.
fn create_component_tree_page_inner(
    ctx: &ReducerContext,
    parent_id: Option<u64>,
    page_type: PageType,
    title: String,
) -> Result<(), String> {
    let sort_order = next_sort_order(ctx, parent_id);
    let page = ctx.db.page().insert(Page {
        id: next_page_id(ctx),
        parent_id,
        sort_order,
        page_type,
        title,
        icon: None,
        embedding: None,
        created_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
        parent_pk: parent_id.unwrap_or(0),
        is_hidden: false,
        content_format: PageContentFormat::ComponentTree,
    });

    seed_default_component_tree(ctx, page.id);

    if let Some(pid) = parent_id {
        copy_page_access_rules_from_parent(ctx, pid, page.id);
    }
    enqueue_page_created(ctx, page.id);
    Ok(())
}

/// Root `Container` + one empty `RichText` — fresh doc is immediately editable.
fn seed_default_component_tree(ctx: &ReducerContext, surface_id: u64) {
    let root_id = next_component_node_id(ctx);
    ctx.db.component_node().insert(ComponentNode {
        id: root_id,
        surface_id,
        parent_id: None,
        component_type: "Container".to_string(),
        props: r#"{"layout":"stack"}"#.to_string(),
        order: 1000,
        created_by: ActorType::Human,
        updated_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
    });

    ctx.db.component_node().insert(ComponentNode {
        id: next_component_node_id(ctx),
        surface_id,
        parent_id: Some(root_id),
        component_type: "RichText".to_string(),
        props: "{}".to_string(),
        order: 1000,
        created_by: ActorType::Human,
        updated_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
    });
}

/// Explicit ComponentTree page creation. Prefer `create_page` with
/// `PageType::Doc` — it now seeds the same tree by default.
#[reducer]
pub fn create_component_tree_page(
    ctx: &ReducerContext,
    parent_id: Option<u64>,
    page_type: PageType,
    title: String,
) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("Title cannot be empty".to_string());
    }
    if let Some(pid) = parent_id {
        require_page_write(ctx, pid)?;
    }
    create_component_tree_page_inner(ctx, parent_id, page_type, title)
}

/// Moves a page to a new parent and/or position.
///
/// `new_parent_id` — target parent (None = root).
/// `after_page_id` — place after this sibling (None = place first).
///
/// Renumbers all siblings of the new parent so sort_order stays clean.
#[reducer]
pub fn move_page(
    ctx: &ReducerContext,
    page_id: u64,
    new_parent_id: Option<u64>,
    after_page_id: Option<u64>,
) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    if let Some(pid) = new_parent_id {
        require_page_write(ctx, pid)?;
    }
    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;

    // Collect and sort active siblings of the new parent (excluding the moving page).
    let mut siblings: Vec<Page> = ctx
        .db
        .page()
        .iter()
        .filter(|p| p.parent_id == new_parent_id && p.deleted_at.is_none() && p.id != page_id)
        .collect();
    siblings.sort_by_key(|p| p.sort_order);

    // Find the insertion index.
    let insert_after = match after_page_id {
        None => 0, // place first
        Some(after_id) => siblings
            .iter()
            .position(|p| p.id == after_id)
            .map(|i| i + 1)
            .unwrap_or(siblings.len()),
    };

    // Splice the moving page into the sorted list (move, no Clone needed).
    siblings.insert(insert_after, page);

    // Renumber all siblings with clean multiples of 1000.
    for (i, sibling) in siblings.into_iter().enumerate() {
        let new_order = (i as u32 + 1) * 1000;
        if sibling.id == page_id {
            ctx.db.page().id().update(Page {
                parent_id: new_parent_id,
                parent_pk: new_parent_id.unwrap_or(0),
                sort_order: new_order,
                updated_at: ctx.timestamp,
                ..sibling
            });
        } else if sibling.sort_order != new_order {
            ctx.db.page().id().update(Page {
                sort_order: new_order,
                ..sibling
            });
        }
    }

    Ok(())
}

#[reducer]
pub fn update_page_title(ctx: &ReducerContext, page_id: u64, title: String) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("Title cannot be empty".to_string());
    }
    require_page_write(ctx, page_id)?;
    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    ctx.db.page().id().update(Page {
        title,
        updated_at: ctx.timestamp,
        ..page
    });
    enqueue_page_updated(ctx, page_id);
    Ok(())
}

/// Set or clear the page icon (emoji). Pass empty string to clear.
#[reducer]
pub fn update_page_icon(ctx: &ReducerContext, page_id: u64, icon: String) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    let new_icon = if icon.trim().is_empty() {
        None
    } else {
        Some(icon.trim().to_string())
    };
    ctx.db.page().id().update(Page {
        icon: new_icon,
        updated_at: ctx.timestamp,
        ..page
    });
    Ok(())
}

/// Persists a semantic embedding for the page (384-dim, `all-MiniLM-L6-v2` / Xenova ONNX).
/// Used by the quick switcher for meaning-based search. Call after content changes (debounced).
#[reducer]
pub fn set_page_embedding(
    ctx: &ReducerContext,
    page_id: u64,
    embedding: Vec<f32>,
) -> Result<(), String> {
    if embedding.is_empty() {
        return Err("embedding must not be empty".to_string());
    }
    if embedding.len() != 384 {
        return Err(format!(
            "embedding must be 384 floats (MiniLM), got {}",
            embedding.len()
        ));
    }
    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    ctx.db.page().id().update(Page {
        embedding: Some(embedding),
        updated_at: ctx.timestamp,
        ..page
    });
    Ok(())
}

/// Updates PageContent (not Page) — content is separate from metadata.
///
/// Refuses to run on `ComponentTree`-format pages. Once a page has migrated
/// to the component-tree substrate, content mutations go through
/// `insert_component` / `update_component_props` / `move_component` /
/// `delete_component` / `save_component_yjs_state` instead. Returning a
/// clear error here is safer than silently writing into a `PageContent` row
/// the renderer no longer reads.
#[reducer]
pub fn update_page_content(
    ctx: &ReducerContext,
    page_id: u64,
    content: String,
) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    if matches!(page.content_format, PageContentFormat::ComponentTree) {
        return Err(
            "Page is in ComponentTree format — use the component reducers \
             (insert_component / update_component_props / save_component_yjs_state) instead"
                .to_string(),
        );
    }
    let existing = ctx
        .db
        .page_content()
        .page_id()
        .find(page_id)
        .ok_or("PageContent not found")?;
    ctx.db.page_content().page_id().update(PageContent {
        content,
        updated_at: ctx.timestamp,
        ..existing
    });
    if ctx.db.page_yjs_state().page_id().find(page_id).is_some() {
        ctx.db.page_yjs_state().page_id().delete(page_id);
    }
    if let Some(page) = ctx.db.page().id().find(page_id) {
        ctx.db.page().id().update(Page {
            updated_at: ctx.timestamp,
            ..page
        });
    }
    enqueue_page_updated(ctx, page_id);
    Ok(())
}

/// Persist the full merged Yjs state for a page.
/// Called periodically by the client (on blur, on unmount, every ~30s).
/// Upserts the single PageYjsState row for the page so row count stays O(1).
/// Also touches the page's updated_at so the sidebar reflects recent activity.
///
/// Refuses to run on `ComponentTree`-format pages — those store Yjs state
/// per-component in `ComponentYjsState`, written by `save_component_yjs_state`.
#[reducer]
pub fn save_yjs_state(ctx: &ReducerContext, page_id: u64, data: Vec<u8>) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    if matches!(page.content_format, PageContentFormat::ComponentTree) {
        return Err(
            "Page is in ComponentTree format — use save_component_yjs_state per RichText component"
                .to_string(),
        );
    }

    if let Some(existing) = ctx.db.page_yjs_state().page_id().find(page_id) {
        ctx.db.page_yjs_state().page_id().update(PageYjsState {
            data,
            updated_at: ctx.timestamp,
            ..existing
        });
    } else {
        ctx.db.page_yjs_state().insert(PageYjsState {
            page_id,
            data,
            updated_at: ctx.timestamp,
        });
    }

    if let Some(page) = ctx.db.page().id().find(page_id) {
        ctx.db.page().id().update(Page {
            updated_at: ctx.timestamp,
            ..page
        });
    }
    Ok(())
}

/// Soft delete — sets deleted_at, never hard deletes.
#[reducer]
pub fn delete_page(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    ctx.db.page().id().update(Page {
        deleted_at: Some(ctx.timestamp),
        updated_at: ctx.timestamp,
        ..page
    });
    enqueue_page_deleted(ctx, page_id);
    Ok(())
}

#[reducer]
pub fn restore_page(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    ctx.db.page().id().update(Page {
        deleted_at: None,
        updated_at: ctx.timestamp,
        ..page
    });
    enqueue_page_updated(ctx, page_id);
    Ok(())
}

/// Register a new attachment after the client uploads the blob to S3/MinIO.
/// Call this once the upload succeeds so the attachment is linked to the page.
#[reducer]
pub fn create_attachment(
    ctx: &ReducerContext,
    page_id: u64,
    filename: String,
    content_type: String,
    storage_key: String,
    size_bytes: u64,
) -> Result<(), String> {
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    if filename.is_empty() || storage_key.is_empty() {
        return Err("filename and storage_key are required".to_string());
    }
    ctx.db.attachment().insert(Attachment {
        id: next_attachment_id(ctx),
        page_id,
        filename,
        content_type,
        storage_key,
        size_bytes,
        created_at: ctx.timestamp,
    });
    Ok(())
}

/// Remove an attachment record. Call after deleting the blob from S3 (or leave orphaned blobs for later cleanup).
#[reducer]
pub fn delete_attachment(ctx: &ReducerContext, attachment_id: u64) -> Result<(), String> {
    ctx.db
        .attachment()
        .id()
        .find(attachment_id)
        .ok_or("Attachment not found")?;
    ctx.db.attachment().id().delete(attachment_id);
    Ok(())
}

/// Permanently delete a soft-deleted page and its direct data. Fails if page is not in trash.
/// Children are reparented to this page's parent (never purged) — we never cascade-delete
/// non-deleted content.
#[reducer]
pub fn purge_page(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    if page.deleted_at.is_none() {
        return Err("Page is not in trash. Move to trash first.".to_string());
    }

    // Reparent children to our parent — never purge them (they may not be in trash)
    let child_ids: Vec<u64> = ctx
        .db
        .page()
        .iter()
        .filter(|p| p.parent_id == Some(page_id))
        .map(|p| p.id)
        .collect();
    for cid in child_ids {
        if let Some(child) = ctx.db.page().id().find(cid) {
            ctx.db.page().id().update(Page {
                parent_id: page.parent_id,
                parent_pk: page.parent_id.unwrap_or(0),
                updated_at: ctx.timestamp,
                ..child
            });
        }
    }

    purge_page_inner(ctx, page_id)
}

fn purge_page_inner(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    // Delete linked data (PageContent is 1:1 with Page)
    ctx.db.page_content().page_id().delete(page_id);

    // Delete the Yjs state blob (single row, primary key = page_id).
    ctx.db.page_yjs_state().page_id().delete(page_id);

    // Cascade-purge the component tree (ComponentNode + ComponentYjsState
    // rows) if this is a ComponentTree-format page. No-op on BlockNote
    // pages where no rows match the surface_id.
    crate::pages::components::purge_component_tree(ctx, page_id);

    let snapshot_ids: Vec<u64> = ctx
        .db
        .page_snapshot()
        .page_id()
        .filter(&page_id)
        .map(|s| s.id)
        .collect();
    for sid in snapshot_ids {
        ctx.db.page_snapshot().id().delete(sid);
    }

    let pv_ids: Vec<u64> = ctx
        .db
        .page_property_value()
        .page_id()
        .filter(&page_id)
        .map(|v| v.id)
        .collect();
    for vid in pv_ids {
        ctx.db.page_property_value().id().delete(vid);
    }

    let hist_ids: Vec<u64> = ctx
        .db
        .page_property_value_history()
        .page_id()
        .filter(&page_id)
        .map(|h| h.id)
        .collect();
    for hid in hist_ids {
        ctx.db.page_property_value_history().id().delete(hid);
    }

    // If database page: delete views, property defs, schemas
    let schema_ids: Vec<u64> = ctx
        .db
        .database_schema()
        .page_id()
        .filter(&page_id)
        .map(|s| s.id)
        .collect();
    for schema_id in &schema_ids {
        let prop_ids: Vec<u64> = ctx
            .db
            .property_definition()
            .schema_id()
            .filter(schema_id)
            .map(|p| p.id)
            .collect();
        for pid in prop_ids {
            ctx.db.property_definition().id().delete(pid);
        }
        ctx.db.database_schema().id().delete(schema_id);
    }

    let view_ids: Vec<u64> = ctx
        .db
        .database_view()
        .page_id()
        .filter(&page_id)
        .map(|v| v.id)
        .collect();
    for vid in view_ids {
        ctx.db.database_view().id().delete(vid);
    }

    ctx.db.page().id().delete(page_id);
    Ok(())
}

/// Toggles the sidebar/search visibility hint on a page (used to host
/// AI-user memory subtrees, etc.). Requires write access.
#[reducer]
pub fn set_page_hidden(ctx: &ReducerContext, page_id: u64, hidden: bool) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    ctx.db.page().id().update(Page {
        is_hidden: hidden,
        updated_at: ctx.timestamp,
        ..page
    });
    Ok(())
}

/// Steering loop: turn an in-the-moment correction into a durable
/// instruction page. Creates a `Doc` page with the given title and content
/// under `parent_page_id` (caller chooses an "Instructions" parent to keep
/// them organised). The page is a regular Doc — instruction discovery is a
/// worker concern (it walks the parent subtree).
#[reducer]
pub fn promote_to_instruction(
    ctx: &ReducerContext,
    parent_page_id: u64,
    title: String,
    content: String,
) -> Result<(), String> {
    let parent = ctx
        .db
        .page()
        .id()
        .find(parent_page_id)
        .ok_or("Parent page not found")?;
    if parent.deleted_at.is_some() {
        return Err("Parent page is deleted".to_string());
    }
    if !can_write_page(ctx, parent_page_id, ctx.sender()) {
        return Err("missing write permission on parent page".to_string());
    }

    let trimmed_title = title.trim();
    if trimmed_title.is_empty() {
        return Err("Title required".to_string());
    }

    let new_page = ctx.db.page().insert(Page {
        id: next_page_id(ctx),
        parent_id: Some(parent_page_id),
        sort_order: next_sort_order(ctx, Some(parent_page_id)),
        page_type: PageType::Doc,
        title: trimmed_title.to_string(),
        icon: Some("📌".to_string()),
        embedding: None,
        created_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
        parent_pk: parent_page_id,
        is_hidden: false,
        content_format: PageContentFormat::BlockNote,
    });
    ctx.db.page_content().insert(PageContent {
        page_id: new_page.id,
        content,
        updated_at: ctx.timestamp,
    });
    copy_page_access_rules_from_parent(ctx, parent_page_id, new_page.id);
    Ok(())
}
