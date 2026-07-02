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
    explicit_page_access_rule_allows, principal_matches_identity, require_rule_authority,
    workspace_member,
};
use crate::access_control::{
    block_access_rule, next_block_access_rule_id, next_page_access_request_id,
    next_page_access_rule_id, page_access_request, page_access_rule, AccessRequestStatus,
    BlockAccessRule, PageAccessRequest, PageAccessRule,
};
use crate::ai::ai_user_profile;
use crate::auth::sender_is_admin;
use crate::conversations::{
    conversation, conversation_message, conversation_participant, next_conversation_message_id,
    Conversation, ConversationMessage, ConversationStatus, MessageSender, MessageStatus,
};
use crate::pages::page;
use crate::types::Permission;

fn sender_is_active_conversation_participant(ctx: &ReducerContext, conversation_id: u64) -> bool {
    ctx.db
        .conversation_participant()
        .conversation_id()
        .filter(&conversation_id)
        .any(|p| p.identity == ctx.sender() && p.left_at.is_none())
}

fn sender_is_ai_user(ctx: &ReducerContext) -> bool {
    ctx.db
        .ai_user_profile()
        .identity()
        .find(ctx.sender())
        .is_some()
}

fn upsert_page_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    principal: Identity,
    permission: Permission,
) {
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
}

fn insert_access_request_resolution_message(
    ctx: &ReducerContext,
    conv: Conversation,
    request: &PageAccessRequest,
    approve: bool,
) {
    let page_title = ctx
        .db
        .page()
        .id()
        .find(request.page_id)
        .map(|p| p.title)
        .unwrap_or_else(|| format!("page {}", request.page_id));
    let permission = match &request.permission {
        Permission::Read => "read",
        Permission::Write => "write",
    };
    let content = if approve {
        format!(
            "Access approved: you now have {permission} access to \"{page_title}\" (page {}). Continue with the previous task.",
            request.page_id
        )
    } else {
        format!(
            "Access denied: do not use \"{page_title}\" (page {}) for the requested {permission} access. Continue without it or ask for a different path.",
            request.page_id
        )
    };

    // Post as a System("access_resolution") trigger, not a User message: the
    // AI user's worker treats it as a wake signal (reconstructed as a user-role
    // note) so it continues the stranded task, and the client hides it from the
    // thread. Attributing it as a human chat turn made it render like a typed
    // message and queue behind the turn lock as if the human had spoken.
    ctx.db
        .conversation_message()
        .insert(ConversationMessage {
            id: next_conversation_message_id(ctx),
            conversation_id: request.conversation_id,
            sender: MessageSender::System("access_resolution".to_string()),
            content,
            job_id: None,
            created_at: ctx.timestamp,
            status: MessageStatus::Complete,
            thinking: None,
            tool_calls_json: None,
            timeline_json: None,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            linked_conversation_id: None,
        });
    ctx.db.conversation().id().update(Conversation {
        updated_at: ctx.timestamp,
        ..conv
    });
}

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
    upsert_page_access_rule(ctx, page_id, principal, permission);
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
        .filter(|r| r.block_id == block_id && principal_matches_identity(&r.principal, principal))
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
        .filter(|r| r.block_id == block_id && principal_matches_identity(&r.principal, principal))
        .collect();
    for rule in to_delete {
        ctx.db.block_access_rule().id().delete(rule.id);
    }
    Ok(())
}

/// Request page access from inside a conversation. The request is created by
/// the caller for itself; only a human participant with rule authority can
/// approve it into a real `PageAccessRule`.
#[reducer]
pub fn request_page_access(
    ctx: &ReducerContext,
    conversation_id: u64,
    page_id: u64,
    permission: Permission,
    reason: String,
) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(conversation_id)
        .ok_or("Conversation not found")?;
    if conv.status != ConversationStatus::Active {
        return Err("Conversation is closed".to_string());
    }
    if !sender_is_active_conversation_participant(ctx, conversation_id) {
        return Err("Caller is not an active participant in this conversation".to_string());
    }
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;

    if explicit_page_access_rule_allows(ctx, page_id, ctx.sender(), &permission) {
        return Ok(());
    }

    let has_pending = ctx
        .db
        .page_access_request()
        .conversation_id()
        .filter(&conversation_id)
        .any(|r| {
            r.page_id == page_id
                && principal_matches_identity(&r.principal, ctx.sender())
                && r.permission == permission
                && r.status == AccessRequestStatus::Pending
        });
    if has_pending {
        return Ok(());
    }

    let trimmed = reason.trim();
    ctx.db.page_access_request().insert(PageAccessRequest {
        id: next_page_access_request_id(ctx),
        conversation_id,
        page_id,
        principal: workspace_member(ctx.sender()),
        permission,
        requested_by: ctx.sender(),
        reason: if trimmed.is_empty() {
            "Requested from chat".to_string()
        } else {
            trimmed.chars().take(500).collect()
        },
        status: AccessRequestStatus::Pending,
        requested_at: ctx.timestamp,
        resolved_by: None,
        resolved_at: None,
    });
    Ok(())
}

/// Resolve a pending chat access request. Approving installs a normal
/// page-access rule; denying only closes the prompt.
#[reducer]
pub fn resolve_page_access_request(
    ctx: &ReducerContext,
    request_id: u64,
    approve: bool,
) -> Result<(), String> {
    if sender_is_ai_user(ctx) {
        return Err("AI users cannot resolve access requests".to_string());
    }

    let request = ctx
        .db
        .page_access_request()
        .id()
        .find(request_id)
        .ok_or("Access request not found")?;
    if request.status != AccessRequestStatus::Pending {
        return Ok(());
    }
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(request.conversation_id)
        .ok_or("Conversation not found")?;
    if conv.status != ConversationStatus::Active {
        return Err("Conversation is closed".to_string());
    }
    if !sender_is_active_conversation_participant(ctx, request.conversation_id)
        && !sender_is_admin(ctx)
    {
        return Err(
            "Only conversation participants or admins can resolve access requests".to_string(),
        );
    }

    if approve {
        require_rule_authority(ctx, request.page_id)?;
        let principal = match &request.principal {
            crate::types::Principal::WorkspaceMember(id) => *id,
        };
        upsert_page_access_rule(ctx, request.page_id, principal, request.permission.clone());
    }

    insert_access_request_resolution_message(ctx, conv, &request, approve);

    ctx.db.page_access_request().id().update(PageAccessRequest {
        status: if approve {
            AccessRequestStatus::Approved
        } else {
            AccessRequestStatus::Denied
        },
        resolved_by: Some(ctx.sender()),
        resolved_at: Some(ctx.timestamp),
        ..request
    });
    Ok(())
}
