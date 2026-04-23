//! Page snapshots: backbone of version history. Manual / Periodic /
//! PreAgentEdit / PostAgentEdit live in the same table; consumers
//! filter by `snapshot_type`.

use spacetimedb::{reducer, table, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::id_counters::alloc_id;
use crate::pages::{page, page_content, page_yjs_state, ActorType, Page, PageContent};

pub(crate) fn next_page_snapshot_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "page_snapshot", || {
        ctx.db.page_snapshot().iter().map(|r| r.id).max().unwrap_or(0)
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

/// Snapshot using whatever is currently in PageContent.
/// Used for manual "Save version" and for agent pre/post snapshots
/// where content is already materialised.
#[reducer]
pub fn take_snapshot(
    ctx: &ReducerContext,
    page_id: u64,
    snapshot_type: SnapshotType,
) -> Result<(), String> {
    let page = ctx
        .db
        .page()
        .id()
        .find(page_id)
        .ok_or("Page not found")?;
    let content = ctx
        .db
        .page_content()
        .page_id()
        .find(page_id)
        .map(|c| c.content)
        .unwrap_or_default();
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
#[reducer]
pub fn take_snapshot_with_content(
    ctx: &ReducerContext,
    page_id: u64,
    snapshot_type: SnapshotType,
    content: String,
) -> Result<(), String> {
    let page = ctx
        .db
        .page()
        .id()
        .find(page_id)
        .ok_or("Page not found")?;

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

    let page = ctx
        .db
        .page()
        .id()
        .find(page_id)
        .ok_or("Page not found")?;
    ctx.db.page().id().update(Page {
        title: restored_title,
        updated_at: ctx.timestamp,
        ..page
    });

    if let Some(existing_content) = ctx.db.page_content().page_id().find(page_id) {
        ctx.db.page_content().page_id().update(PageContent {
            content: restored_content,
            updated_at: ctx.timestamp,
            ..existing_content
        });
    }

    // Clear the Yjs state blob so the client re-bootstraps from the restored
    // PageContent JSON on next open (the client will re-derive a Yjs state from it).
    if ctx.db.page_yjs_state().page_id().find(page_id).is_some() {
        ctx.db.page_yjs_state().page_id().delete(page_id);
    }

    Ok(())
}

