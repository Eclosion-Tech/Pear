// ============================================================
// Access control helpers
// ============================================================
//
// Semantics: rules *restrict* rather than grant. If zero rules exist for a
// page, the open model applies and any authenticated principal can read or
// write. Once any rule exists for a page, only principals with an explicit
// matching rule (or admins) may act. `Write` implies `Read`.

use spacetimedb::{Identity, ReducerContext};

use crate::access_control::{block_access_rule, page_access_rule, BlockAccessRule};
use crate::auth::{sender_is_admin, user};
use crate::module_install::sender_is_module_publisher;
use crate::types::{Permission, Principal};

pub(crate) fn page_has_any_rule(ctx: &ReducerContext, page_id: u64) -> bool {
    ctx.db
        .page_access_rule()
        .page_id()
        .filter(&page_id)
        .next()
        .is_some()
}

fn principal_has_page_permission(
    ctx: &ReducerContext,
    page_id: u64,
    principal: Identity,
    needed: &Permission,
) -> bool {
    for rule in ctx.db.page_access_rule().page_id().filter(&page_id) {
        if !principal_matches_identity(&rule.principal, principal) {
            continue;
        }
        match (&rule.permission, needed) {
            // Write implies Read.
            (Permission::Write, _) => return true,
            (Permission::Read, Permission::Read) => return true,
            _ => continue,
        }
    }
    false
}

/// True iff `identity` may read `page_id`. Open-by-default.
pub fn can_read_page(ctx: &ReducerContext, page_id: u64, identity: Identity) -> bool {
    if !page_has_any_rule(ctx, page_id) {
        return true;
    }
    if let Some(u) = ctx.db.user().identity().find(identity) {
        if u.is_admin && u.is_authenticated {
            return true;
        }
    }
    principal_has_page_permission(ctx, page_id, identity, &Permission::Read)
}

/// True iff `identity` may write `page_id`. Open-by-default.
pub fn can_write_page(ctx: &ReducerContext, page_id: u64, identity: Identity) -> bool {
    if !page_has_any_rule(ctx, page_id) {
        return true;
    }
    if let Some(u) = ctx.db.user().identity().find(identity) {
        if u.is_admin && u.is_authenticated {
            return true;
        }
    }
    principal_has_page_permission(ctx, page_id, identity, &Permission::Write)
}

/// Reducer guard: ensures the caller may write the page or returns the
/// canonical rejection string used by every page-mutating reducer below.
pub(crate) fn require_page_write(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    if can_write_page(ctx, page_id, ctx.sender()) {
        Ok(())
    } else {
        Err("Caller lacks write access on this page".to_string())
    }
}

/// Reducer guard: ensures the caller may read the page (used by reducers
/// that surface page state through side effects, e.g. snapshotting).
#[allow(dead_code)]
fn require_page_read(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    if can_read_page(ctx, page_id, ctx.sender()) {
        Ok(())
    } else {
        Err("Caller lacks read access on this page".to_string())
    }
}

/// True iff `identity` may read a specific block. Falls back to page-level
/// access when no block rule exists. Useful for the AI context assembler;
/// the live Yjs blob is not server-filtered today.
///
/// Currently unused in-tree: the context assembler that will call this
/// is scheduled for Phase 5 of `FEATURE_ai_users.md`. Kept here so the
/// scaffolding ships alongside the `BlockAccessRule` table.
#[allow(dead_code)]
pub fn can_read_block(
    ctx: &ReducerContext,
    page_id: u64,
    block_id: &str,
    identity: Identity,
) -> bool {
    let block_rules: Vec<BlockAccessRule> = ctx
        .db
        .block_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| r.block_id == block_id)
        .collect();

    if block_rules.is_empty() {
        return can_read_page(ctx, page_id, identity);
    }
    if let Some(u) = ctx.db.user().identity().find(identity) {
        if u.is_admin && u.is_authenticated {
            return true;
        }
    }
    block_rules
        .iter()
        .any(|r| principal_matches_identity(&r.principal, identity))
}

// ============================================================
// Principal helpers.
// ============================================================
// During the rev-3 access-rule refactor, `PageAccessRule.principal` and
// `BlockAccessRule.principal` flipped from `Identity` to the typed
// `Principal` enum. These helpers keep the call sites readable while only
// the `WorkspaceMember` variant exists; future variants slot in here.

/// Returns true iff this principal represents the given workspace-member
/// identity. End-user / API-key variants always return `false` today.
pub(crate) fn principal_matches_identity(principal: &Principal, identity: Identity) -> bool {
    match principal {
        Principal::WorkspaceMember(id) => *id == identity,
    }
}

/// Convenience: wrap an `Identity` as a workspace-member principal.
pub(crate) fn workspace_member(identity: Identity) -> Principal {
    Principal::WorkspaceMember(identity)
}

/// Authorization helper for `created_by`-gated infrastructure reducers.
/// Returns `Ok(())` if the sender is the original creator, a workspace admin,
/// or the [module publisher](crate::module_install::ModuleInstallMeta).
pub(crate) fn require_creator_or_admin(
    ctx: &ReducerContext,
    created_by: Identity,
    action: &str,
) -> Result<(), String> {
    if created_by == ctx.sender() || sender_is_admin(ctx) || sender_is_module_publisher(ctx) {
        Ok(())
    } else {
        Err(format!(
            "Only the creator, a workspace admin, or the module publisher can {action}"
        ))
    }
}

pub(crate) fn require_rule_authority(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    if !page_has_any_rule(ctx, page_id) {
        return Ok(());
    }
    require_page_write(ctx, page_id)
}
