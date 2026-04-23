//! Saved view configuration on a Database page. Either shared
//! (`owner_identity = None`) or personal.

use spacetimedb::{reducer, table, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::id_counters::alloc_id;
use crate::pages::{page, ActorType};

pub(crate) fn next_database_view_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "database_view", || {
        ctx.db.database_view().iter().map(|r| r.id).max().unwrap_or(0)
    })
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ViewType {
    Grid,
    List,
    Kanban,
    Calendar,
    Gallery,
}

/// Saved view config on a database page. Synced across devices.
#[table(accessor = database_view, public)]
pub struct DatabaseView {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub name: String,
    pub view_type: ViewType,
    /// JSON string: filters, sorts, column visibility, column widths.
    pub config: String,
    pub is_default: bool,
    /// None = shared view, Some(identity_hex) = personal view.
    pub owner_identity: Option<String>,
    pub created_by: ActorType,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}


// ============================================================
// View Reducers
// ============================================================

/// Creates a view. First view for a page is automatically set as default.
#[reducer]
pub fn create_view(
    ctx: &ReducerContext,
    page_id: u64,
    name: String,
    view_type: ViewType,
    owner_identity: Option<String>,
) -> Result<(), String> {
    ctx.db
        .page()
        .id()
        .find(page_id)
        .ok_or("Page not found")?;
    let is_default = ctx
        .db
        .database_view()
        .page_id()
        .filter(&page_id)
        .next()
        .is_none();
    ctx.db.database_view().insert(DatabaseView {
        id: next_database_view_id(ctx),
        page_id,
        name,
        view_type,
        config: "{}".to_string(),
        is_default,
        owner_identity,
        created_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    Ok(())
}

#[reducer]
pub fn update_view_config(ctx: &ReducerContext, view_id: u64, config: String) -> Result<(), String> {
    let view = ctx
        .db
        .database_view()
        .id()
        .find(view_id)
        .ok_or("View not found")?;
    ctx.db.database_view().id().update(DatabaseView {
        config,
        updated_at: ctx.timestamp,
        ..view
    });
    Ok(())
}

#[reducer]
pub fn rename_view(ctx: &ReducerContext, view_id: u64, name: String) -> Result<(), String> {
    let view = ctx
        .db
        .database_view()
        .id()
        .find(view_id)
        .ok_or("View not found")?;
    ctx.db.database_view().id().update(DatabaseView {
        name,
        updated_at: ctx.timestamp,
        ..view
    });
    Ok(())
}

/// Clears is_default on all other views for this page, then sets the target.
#[reducer]
pub fn set_default_view(ctx: &ReducerContext, view_id: u64) -> Result<(), String> {
    let target = ctx
        .db
        .database_view()
        .id()
        .find(view_id)
        .ok_or("View not found")?;
    let page_id = target.page_id;

    // Collect other current-default views before mutating
    let current_defaults: Vec<DatabaseView> = ctx
        .db
        .database_view()
        .page_id()
        .filter(&page_id)
        .filter(|v| v.is_default && v.id != view_id)
        .collect();

    for view in current_defaults {
        ctx.db.database_view().id().update(DatabaseView {
            is_default: false,
            updated_at: ctx.timestamp,
            ..view
        });
    }

    ctx.db.database_view().id().update(DatabaseView {
        is_default: true,
        updated_at: ctx.timestamp,
        ..target
    });
    Ok(())
}

#[reducer]
pub fn delete_view(ctx: &ReducerContext, view_id: u64) -> Result<(), String> {
    ctx.db.database_view().id().delete(view_id);
    Ok(())
}

