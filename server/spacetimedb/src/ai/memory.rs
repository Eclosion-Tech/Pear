//! Per-AI-user memory subtree: a hidden Page hosting `working` (small,
//! frequently rewritten) and `long_term` (consolidated weekly) memory
//! rows. Provisioned lazily by `provision_ai_user_memory`. Torn down (soft-delete
//! subtree + drop the link row) by `disable_ai_user_memory`.

use std::collections::{HashSet, VecDeque};

use spacetimedb::{reducer, table, ReducerContext, Table, Timestamp};

use crate::access_control::helpers::{require_creator_or_admin, require_page_write};
use crate::ai::{ai_user_config, ai_user_profile};
use crate::id_counters::alloc_id;
use crate::pages::{
    next_page_id, next_sort_order, page, page_content, ActorType, Page, PageContent, PageType,
};

pub(crate) fn next_ai_user_memory_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "ai_user_memory", || {
        ctx.db.ai_user_memory().iter().map(|r| r.id).max().unwrap_or(0)
    })
}
/// AI-user memory: a hidden subtree per AI user, two-tier (working /
/// long-term). `working` memory stays small and is rewritten freely;
/// `long_term` is consolidated by a weekly Orcha job. Both are just Page
/// rows under `root_page_id` (which has `is_hidden = true` — see Phase 0).
#[table(accessor = ai_user_memory, public)]
pub struct AiUserMemory {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[unique]
    pub ai_user_id: u64,
    /// Hidden Page that hosts the memory subtree.
    pub root_page_id: u64,
    /// Page under root that holds the working-memory snapshot (small,
    /// frequently rewritten). Nullable until first write.
    pub working_page_id: Option<u64>,
    /// Page under root that holds the consolidated long-term memory.
    pub long_term_page_id: Option<u64>,
    pub created_at: Timestamp,
    pub last_consolidated_at: Option<Timestamp>,
}

/// Provision the per-AI-user memory subtree. Idempotent — returns OK if
/// the row already exists. The subtree root is created with
/// `is_hidden = true` so it never shows up in regular sidebar nav.
#[reducer]
pub fn provision_ai_user_memory(ctx: &ReducerContext, ai_user_id: u64) -> Result<(), String> {
    let ai_user = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user not found")?;
    require_creator_or_admin(ctx, ai_user.created_by, "provision memory")?;

    if ctx
        .db
        .ai_user_memory()
        .ai_user_id()
        .find(ai_user_id)
        .is_some()
    {
        return Ok(());
    }

    let profile = ctx
        .db
        .ai_user_profile()
        .ai_user_id()
        .find(ai_user_id)
        .ok_or("AI user profile missing")?;

    let root = ctx.db.page().insert(Page {
        id: next_page_id(ctx),
        parent_id: None,
        sort_order: next_sort_order(ctx, None),
        page_type: PageType::Doc,
        title: format!("Memory · {}", profile.display_name),
        icon: Some("brain".to_string()),
        embedding: None,
        created_by: ActorType::Agent("memory".to_string()),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
        parent_pk: 0,
        is_hidden: true,
    });
    ctx.db.page_content().insert(PageContent {
        page_id: root.id,
        content: String::new(),
        updated_at: ctx.timestamp,
    });
    ctx.db.ai_user_memory().insert(AiUserMemory {
        id: next_ai_user_memory_id(ctx),
        ai_user_id,
        root_page_id: root.id,
        working_page_id: None,
        long_term_page_id: None,
        created_at: ctx.timestamp,
        last_consolidated_at: None,
    });
    Ok(())
}

/// Live pages in the subtree rooted at `root_id` (BFS), excluding already soft-deleted pages.
fn collect_live_subtree_page_ids(ctx: &ReducerContext, root_id: u64) -> Vec<u64> {
    let mut out = Vec::new();
    let mut queue = VecDeque::new();
    let mut seen = HashSet::new();

    if ctx.db.page().id().find(root_id).is_none() {
        return out;
    }
    queue.push_back(root_id);

    while let Some(id) = queue.pop_front() {
        if !seen.insert(id) {
            continue;
        }
        let Some(page) = ctx.db.page().id().find(id) else {
            continue;
        };
        if page.deleted_at.is_some() {
            continue;
        }
        out.push(id);
        for child in ctx.db.page().iter() {
            if child.parent_id == Some(id) && child.deleted_at.is_none() {
                queue.push_back(child.id);
            }
        }
    }
    out
}

/// Remove the `ai_user_memory` row and soft-delete every page in the memory subtree.
/// Idempotent if no memory row exists. Only the AI user's creator or a workspace admin may call.
#[reducer]
pub fn disable_ai_user_memory(ctx: &ReducerContext, ai_user_id: u64) -> Result<(), String> {
    let ai_user = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user not found")?;
    require_creator_or_admin(ctx, ai_user.created_by, "disable memory")?;

    let Some(mem) = ctx.db.ai_user_memory().ai_user_id().find(ai_user_id) else {
        return Ok(());
    };

    let root_id = mem.root_page_id;
    let to_soft_delete = collect_live_subtree_page_ids(ctx, root_id);

    for pid in to_soft_delete {
        let page = ctx
            .db
            .page()
            .id()
            .find(pid)
            .ok_or("Page disappeared during memory teardown")?;
        if page.deleted_at.is_some() {
            continue;
        }
        require_page_write(ctx, pid)?;
        ctx.db.page().id().update(Page {
            deleted_at: Some(ctx.timestamp),
            updated_at: ctx.timestamp,
            ..page
        });
    }

    ctx.db.ai_user_memory().id().delete(mem.id);
    Ok(())
}
