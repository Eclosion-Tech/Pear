//! Page snapshots: backbone of version history. Manual / Periodic /
//! PreAgentEdit / PostAgentEdit live in the same table; consumers
//! filter by `snapshot_type`.

use spacetimedb::{reducer, table, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::id_counters::alloc_id;
use crate::pages::components::{
    purge_component_tree, restore_component_tree, serialize_component_tree, PageContentFormat,
};
use crate::pages::{page, page_content, page_yjs_state, ActorType, Page, PageContent};

pub(crate) fn next_page_snapshot_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "page_snapshot", || {
        ctx.db
            .page_snapshot()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum SnapshotType {
    Manual,
    Periodic,
    PreAgentEdit,
    PostAgentEdit,
}

/// Point-in-time snapshot of a page. Backbone of version history.
#[table(accessor = page_snapshot, public)]
pub struct PageSnapshot {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub title: String,
    pub content: String,
    pub snapshot_at: Timestamp,
    pub created_by: ActorType,
    pub snapshot_type: SnapshotType,
}

// ============================================================
// Snapshot Reducers
// ============================================================

/// Snapshot the page's current content.
///
/// For `BlockNote` pages, content is whatever's currently in `PageContent`
/// (BlockNote JSON). For `ComponentTree` pages, content is a serialized
/// `component_tree_v1` JSON blob produced by
/// `serialize_component_tree` — captures every live `ComponentNode` row
/// plus the base64-encoded `ComponentYjsState` bytes for any
/// Yjs-backed components, so restore is round-trip exact.
///
/// Used for manual "Save version" and for agent pre/post snapshots where
/// content is already materialised in the substrate.
#[reducer]
pub fn take_snapshot(
    ctx: &ReducerContext,
    page_id: u64,
    snapshot_type: SnapshotType,
) -> Result<(), String> {
    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    let content = match page.content_format {
        PageContentFormat::BlockNote => ctx
            .db
            .page_content()
            .page_id()
            .find(page_id)
            .map(|c| c.content)
            .unwrap_or_default(),
        PageContentFormat::ComponentTree => serialize_component_tree(ctx, page_id)?,
    };
    ctx.db.page_snapshot().insert(PageSnapshot {
        id: next_page_snapshot_id(ctx),
        page_id,
        title: page.title,
        content,
        snapshot_at: ctx.timestamp,
        created_by: ActorType::Human,
        snapshot_type,
    });
    Ok(())
}

/// Snapshot with content supplied by the client (e.g. from the live Yjs editor).
/// Also syncs PageContent so it stays current — important because PageContent is
/// the source of truth for restore and for take_snapshot above.
/// Used for Periodic auto-saves: the editor serialises its live state and calls
/// this every N minutes while the page is open.
///
/// Refuses to run on `ComponentTree` pages — those store content per-component
/// in the substrate, so the client should persist Yjs state via
/// `save_component_yjs_state` and then call the parameter-less
/// `take_snapshot` (which already reads from the substrate). Conceptually
/// there's no "live editor state separate from the substrate" for
/// component-tree pages.
#[reducer]
pub fn take_snapshot_with_content(
    ctx: &ReducerContext,
    page_id: u64,
    snapshot_type: SnapshotType,
    content: String,
) -> Result<(), String> {
    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    if matches!(page.content_format, PageContentFormat::ComponentTree) {
        return Err(
            "Page is in ComponentTree format — persist per-component state via \
             save_component_yjs_state, then call take_snapshot (which reads from the substrate)."
                .to_string(),
        );
    }

    // Keep PageContent in sync with actual editor state.
    if let Some(existing) = ctx.db.page_content().page_id().find(page_id) {
        ctx.db.page_content().page_id().update(PageContent {
            content: content.clone(),
            updated_at: ctx.timestamp,
            ..existing
        });
    }

    ctx.db.page_snapshot().insert(PageSnapshot {
        id: next_page_snapshot_id(ctx),
        page_id,
        title: page.title,
        content,
        snapshot_at: ctx.timestamp,
        created_by: ActorType::Human,
        snapshot_type,
    });
    Ok(())
}

/// Rolls page title and content back to a previous snapshot.
///
/// Branches on the page's current `content_format` so each format restores
/// to its own substrate:
///
/// - `BlockNote`: writes `snapshot.content` back into `PageContent` and
///   wipes `PageYjsState` so the editor re-derives Yjs from the restored
///   JSON on next open.
/// - `ComponentTree`: parses `snapshot.content` as a `component_tree_v1`
///   JSON blob, wipes the surface's current `ComponentNode` +
///   `ComponentYjsState` rows, and re-creates them from the snapshot via
///   `restore_component_tree`. Whole reducer is one transactional unit, so
///   a malformed snapshot rolls back the wipe.
///
/// The page's `content_format` is immutable through this reducer —
/// snapshots taken in one format cannot restore into a page that has
/// since been converted to the other format. The migration tool is the
/// only place format flips happen.
#[reducer]
pub fn restore_page_to_snapshot(
    ctx: &ReducerContext,
    page_id: u64,
    snapshot_id: u64,
) -> Result<(), String> {
    let snapshot = ctx
        .db
        .page_snapshot()
        .id()
        .find(snapshot_id)
        .ok_or("Snapshot not found")?;
    if snapshot.page_id != page_id {
        return Err("Snapshot does not belong to this page".to_string());
    }
    let restored_title = snapshot.title.clone();
    let restored_content = snapshot.content.clone();

    let page = ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    let format = page.content_format.clone();
    ctx.db.page().id().update(Page {
        title: restored_title,
        updated_at: ctx.timestamp,
        ..page
    });

    match format {
        PageContentFormat::BlockNote => {
            if let Some(existing_content) = ctx.db.page_content().page_id().find(page_id) {
                ctx.db.page_content().page_id().update(PageContent {
                    content: restored_content,
                    updated_at: ctx.timestamp,
                    ..existing_content
                });
            }
            // Clear the Yjs state blob so the client re-bootstraps from
            // the restored PageContent JSON on next open.
            if ctx.db.page_yjs_state().page_id().find(page_id).is_some() {
                ctx.db.page_yjs_state().page_id().delete(page_id);
            }
        }
        PageContentFormat::ComponentTree => {
            // Wipe + re-create. `restore_component_tree` calls
            // `purge_component_tree` internally, but we call it explicitly
            // first too so a snapshot with an empty `nodes` array still
            // clears the surface (the snapshot may legitimately represent
            // an empty page).
            purge_component_tree(ctx, page_id);
            restore_component_tree(ctx, page_id, &restored_content)?;
        }
    }

    Ok(())
}
