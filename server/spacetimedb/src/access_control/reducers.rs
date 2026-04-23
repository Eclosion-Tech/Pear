// ============================================================
// Access Control Reducers
// ============================================================
//
// "Mutating the rules of the page" is itself a write on the page. Once a
// page has any rule, only existing writers (or admins) can change the rule
// set — otherwise a single mistake could lock the workspace out. A page
// with zero rules is open, so anyone can install the *first* rule.

use spacetimedb::{reducer, Identity, ReducerContext, Table};

use crate::access_control::helpers::{
    principal_matches_identity, require_rule_authority, workspace_member,
};
use crate::access_control::{
    block_access_rule, next_block_access_rule_id, next_page_access_rule_id, page_access_rule,
    BlockAccessRule, PageAccessRule,
};
use crate::pages::page;
use crate::types::Permission;

/// Grants `principal` `permission` on `page_id`. Upserts: if a rule already
/// exists for the principal it is replaced (so promoting Read → Write is
/// idempotent and Write → Read is a true demotion).
#[reducer]
pub fn set_page_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    principal: Identity,
    permission: Permission,
) -> Result<(), String> {
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    require_rule_authority(ctx, page_id)?;

    let existing: Vec<PageAccessRule> = ctx
        .db
        .page_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| principal_matches_identity(&r.principal, principal))
        .collect();
    for rule in existing {
        ctx.db.page_access_rule().id().delete(rule.id);
    }

    ctx.db.page_access_rule().insert(PageAccessRule {
        id: next_page_access_rule_id(ctx),
        page_id,
        principal: workspace_member(principal),
        permission,
        granted_by: ctx.sender(),
        granted_at: ctx.timestamp,
    });
    Ok(())
}

/// Removes any rule for `principal` on `page_id`. If this drops the rule
/// count to zero the page returns to the open model.
#[reducer]
pub fn clear_page_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    principal: Identity,
) -> Result<(), String> {
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    require_rule_authority(ctx, page_id)?;

    let to_delete: Vec<PageAccessRule> = ctx
        .db
        .page_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| principal_matches_identity(&r.principal, principal))
        .collect();
    for rule in to_delete {
        ctx.db.page_access_rule().id().delete(rule.id);
    }
    Ok(())
}

#[reducer]
pub fn set_block_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    block_id: String,
    principal: Identity,
    permission: Permission,
) -> Result<(), String> {
    if block_id.trim().is_empty() {
        return Err("block_id cannot be empty".to_string());
    }
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    require_rule_authority(ctx, page_id)?;

    let existing: Vec<BlockAccessRule> = ctx
        .db
        .block_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| {
            r.block_id == block_id && principal_matches_identity(&r.principal, principal)
        })
        .collect();
    for rule in existing {
        ctx.db.block_access_rule().id().delete(rule.id);
    }

    ctx.db.block_access_rule().insert(BlockAccessRule {
        id: next_block_access_rule_id(ctx),
        page_id,
        block_id,
        principal: workspace_member(principal),
        permission,
        granted_by: ctx.sender(),
        granted_at: ctx.timestamp,
    });
    Ok(())
}

#[reducer]
pub fn clear_block_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    block_id: String,
    principal: Identity,
) -> Result<(), String> {
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    require_rule_authority(ctx, page_id)?;
    let to_delete: Vec<BlockAccessRule> = ctx
        .db
        .block_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| {
            r.block_id == block_id && principal_matches_identity(&r.principal, principal)
        })
        .collect();
    for rule in to_delete {
        ctx.db.block_access_rule().id().delete(rule.id);
    }
    Ok(())
}
