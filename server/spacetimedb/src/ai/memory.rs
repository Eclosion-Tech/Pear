//! Per-AI-user memory subtree: a hidden Page hosting `working` (small,
//! frequently rewritten) and `long_term` (consolidated weekly) memory
//! rows. Provisioned lazily by `provision_ai_user_memory`. Torn down (soft-delete
//! subtree + drop the link row) by `disable_ai_user_memory`.

use std::collections::{HashSet, VecDeque};

use spacetimedb::{reducer, table, Identity, ReducerContext, Table, Timestamp};

use crate::access_control::helpers::{require_creator_or_admin, workspace_member};
use crate::access_control::{next_page_access_rule_id, page_access_rule, PageAccessRule};
use crate::ai::{ai_user_config, ai_user_profile};
use crate::id_counters::alloc_id;
use crate::pages::{
    next_page_id, next_sort_order, page, seed_default_component_tree, ActorType, Page,
    PageContentFormat, PageType,
};
use crate::types::Permission;

pub(crate) fn next_ai_user_memory_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "ai_user_memory", || {
        ctx.db
            .ai_user_memory()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

/// Restricts `page_id` so only `ai_identity` has access (write implies read). Used for
/// AI-user memory pages so workspace members do not inherit the default open model.
pub(crate) fn grant_ai_memory_page_access(
    ctx: &ReducerContext,
    page_id: u64,
    ai_identity: Identity,
) {
    ctx.db.page_access_rule().insert(PageAccessRule {
        id: next_page_access_rule_id(ctx),
        page_id,
        principal: workspace_member(ai_identity),
        permission: Permission::Write,
        granted_by: ctx.sender(),
        granted_at: ctx.timestamp,
    });
}

/// Grants the AI user's human creator *read* access to a memory page. The AI
/// keeps Write (via `grant_ai_memory_page_access`); the creator is read-only, so
/// a non-admin creator can inspect and correct what the AI has stored without
/// being able to author its memory directly. Without this, once the AI-only rule
/// exists only the AI or an admin can see the subtree — the creator is locked
/// out of the memory they're accountable for.
pub(crate) fn grant_ai_memory_creator_read(
    ctx: &ReducerContext,
    page_id: u64,
    creator: Identity,
) {
    ctx.db.page_access_rule().insert(PageAccessRule {
        id: next_page_access_rule_id(ctx),
        page_id,
        principal: workspace_member(creator),
        permission: Permission::Read,
        granted_by: ctx.sender(),
        granted_at: ctx.timestamp,
    });
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
        content_format: PageContentFormat::ComponentTree,
    });
    // ComponentTree pages store body in `ComponentNode` rows (not `PageContent`);
    // seed the same root Container + empty RichText that a normal Doc gets.
    seed_default_component_tree(ctx, root.id);
    grant_ai_memory_page_access(ctx, root.id, ai_user.identity);
    // The human creator gets read-only visibility into the AI's memory so they
    // can inspect/correct it — a rule on the root covers the whole subtree.
    if ai_user.created_by != ai_user.identity {
        grant_ai_memory_creator_read(ctx, root.id, ai_user.created_by);
    }
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

/// Stamp `last_consolidated_at` on an AI user's memory row — called at the end
/// of a consolidation pass so the next pass (and the UI) can see when memory was
/// last tidied. Callable by the AI user itself (its own consolidation turn) or
/// by the creator/admin.
#[reducer]
pub fn mark_ai_memory_consolidated(ctx: &ReducerContext, ai_user_id: u64) -> Result<(), String> {
    let ai_user = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user not found")?;
    // The AI user may stamp its own memory; anyone else must be creator/admin.
    if ctx.sender() != ai_user.identity {
        require_creator_or_admin(ctx, ai_user.created_by, "mark memory consolidated")?;
    }
    let mem = ctx
        .db
        .ai_user_memory()
        .ai_user_id()
        .find(ai_user_id)
        .ok_or("AI user has no provisioned memory")?;
    ctx.db.ai_user_memory().id().update(AiUserMemory {
        last_consolidated_at: Some(ctx.timestamp),
        ..mem
    });
    Ok(())
}

/// Live pages in the subtree rooted at `root_id` (BFS), excluding already soft-deleted pages.
pub(crate) fn collect_live_subtree_page_ids(ctx: &ReducerContext, root_id: u64) -> Vec<u64> {
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
        ctx.db.page().id().update(Page {
            deleted_at: Some(ctx.timestamp),
            updated_at: ctx.timestamp,
            ..page
        });
    }

    ctx.db.ai_user_memory().id().delete(mem.id);
    Ok(())
}

/// Merge one AI user into another, then delete the source. Built for
/// condensing duplicate external-MCP identities (each historical OAuth
/// onboarding could mint a fresh "MCP: …" user) down to the active one:
///
/// * **Memory carries over.** If the target has no memory subtree, the
///   source's is re-keyed to the target wholesale. If both have one, the
///   source's root page is nested under the target's root as a
///   "Merged memory — <name>" folder — nothing is deleted, the target can
///   consolidate at leisure. Either way the target identity is granted access
///   to the carried-over pages (their old rules referenced the source
///   identity, which is about to disappear).
/// * **Bridge grants transfer** (idempotently) so the surviving user keeps
///   device access.
/// * Historical conversation messages keep their original sender identity —
///   they render like any other deleted user's messages.
///
/// Gated on creator-or-admin for BOTH users.
#[reducer]
pub fn merge_ai_users(
    ctx: &ReducerContext,
    source_ai_user_id: u64,
    target_ai_user_id: u64,
) -> Result<(), String> {
    if source_ai_user_id == target_ai_user_id {
        return Err("Cannot merge an AI user into itself".to_string());
    }
    let source = ctx
        .db
        .ai_user_config()
        .id()
        .find(source_ai_user_id)
        .ok_or("Source AI user not found")?;
    let target = ctx
        .db
        .ai_user_config()
        .id()
        .find(target_ai_user_id)
        .ok_or("Target AI user not found")?;
    require_creator_or_admin(ctx, source.created_by, "merge AI users")?;
    require_creator_or_admin(ctx, target.created_by, "merge AI users")?;

    let source_name = ctx
        .db
        .ai_user_profile()
        .ai_user_id()
        .find(source_ai_user_id)
        .map(|p| p.display_name)
        .unwrap_or_else(|| format!("AI user {source_ai_user_id}"));

    // ── Memory ────────────────────────────────────────────────────────────
    if let Some(src_mem) = ctx.db.ai_user_memory().ai_user_id().find(source_ai_user_id) {
        match ctx.db.ai_user_memory().ai_user_id().find(target_ai_user_id) {
            None => {
                let root_page_id = src_mem.root_page_id;
                ctx.db.ai_user_memory().id().update(AiUserMemory {
                    ai_user_id: target_ai_user_id,
                    ..src_mem
                });
                grant_ai_memory_page_access(ctx, root_page_id, target.identity);
            }
            Some(tgt_mem) => {
                if let Some(root) = ctx.db.page().id().find(src_mem.root_page_id) {
                    ctx.db.page().id().update(Page {
                        parent_id: Some(tgt_mem.root_page_id),
                        title: format!("Merged memory — {source_name}"),
                        sort_order: next_sort_order(ctx, Some(tgt_mem.root_page_id)),
                        ..root
                    });
                }
                grant_ai_memory_page_access(ctx, src_mem.root_page_id, target.identity);
                ctx.db.ai_user_memory().id().delete(&src_mem.id);
            }
        }
    }

    // ── Bridge device grants ──────────────────────────────────────────────
    use crate::bridge::{
        bridge_device_grant, next_bridge_device_grant_id, BridgeDeviceGrant,
    };
    let source_grants: Vec<BridgeDeviceGrant> = ctx
        .db
        .bridge_device_grant()
        .iter()
        .filter(|g| g.ai_user_identity == source.identity)
        .collect();
    for grant in source_grants {
        let target_has = ctx
            .db
            .bridge_device_grant()
            .device_id()
            .filter(grant.device_id)
            .any(|g| g.ai_user_identity == target.identity);
        if !target_has {
            ctx.db.bridge_device_grant().insert(BridgeDeviceGrant {
                id: next_bridge_device_grant_id(ctx),
                device_id: grant.device_id,
                ai_user_identity: target.identity,
                granted_by: grant.granted_by,
                granted_at: ctx.timestamp,
            });
        }
        ctx.db.bridge_device_grant().id().delete(&grant.id);
    }

    // ── Delete the source user (config + profile) ─────────────────────────
    ctx.db.ai_user_config().id().delete(source_ai_user_id);
    ctx.db.ai_user_profile().ai_user_id().delete(source_ai_user_id);
    log::info!(
        "AI user {source_ai_user_id} ({source_name}) merged into {target_ai_user_id}"
    );
    Ok(())
}
