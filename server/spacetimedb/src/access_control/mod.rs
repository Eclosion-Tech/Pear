// ============================================================
// Access Control Tables
// ============================================================

use spacetimedb::{table, Identity, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::id_counters::alloc_id;
use crate::types::{Permission, Principal};

pub(crate) mod helpers;
pub(crate) mod reducers;

pub(crate) fn next_page_access_rule_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "page_access_rule", || {
        ctx.db
            .page_access_rule()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_block_access_rule_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "block_access_rule", || {
        ctx.db
            .block_access_rule()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_page_access_request_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "page_access_request", || {
        ctx.db
            .page_access_request()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

/// Per-page, per-principal access grant. Rules *restrict* — the absence of
/// any rule for a page means the open model applies (any authenticated
/// caller can read and write). When at least one rule exists for a page,
/// only listed principals (with the appropriate `Permission`) plus
/// workspace admins may act on it.
///
/// `principal` is an `Identity`, which generalises across human and AI
/// users — both are first-class principals per `FEATURE_ai_users.md`.
#[table(accessor = page_access_rule, public)]
pub struct PageAccessRule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    /// Typed grantee. Today only `Principal::WorkspaceMember(Identity)` is
    /// populated; future end-user / API-key variants slot in without
    /// schema migration.
    pub principal: Principal,
    pub permission: Permission,
    pub granted_by: Identity,
    pub granted_at: Timestamp,
}

/// Per-block, per-principal access grant. Same restrict-not-grant semantic
/// as `page_access_rule`. The combination `(page_id, block_id)` identifies
/// a block within a page; `block_id` is the BlockNote block id (a string,
/// since BlockNote uses uuid-style ids).
///
/// Block-level enforcement against the live Yjs blob is partial — see the
/// Phase A discussion in `FEATURE_ai_users.md`. The MVP enforcement point
/// is the context payload assembled for AI users; the field exists in
/// schema today so we can subscribe and query against it from clients.
#[table(
    accessor = block_access_rule,
    public,
)]
pub struct BlockAccessRule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub block_id: String,
    /// Typed grantee. See `PageAccessRule.principal` for the enum
    /// extensibility rationale.
    pub principal: Principal,
    pub permission: Permission,
    pub granted_by: Identity,
    pub granted_at: Timestamp,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum AccessRequestStatus {
    Pending,
    Approved,
    Denied,
}

/// A chat-originated request for a human to grant page access to the
/// requesting principal. The eventual grant is still a normal
/// `PageAccessRule`; this row is only the conversation/approval workflow.
#[table(accessor = page_access_request, public)]
pub struct PageAccessRequest {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub conversation_id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub principal: Principal,
    pub permission: Permission,
    pub requested_by: Identity,
    pub reason: String,
    pub status: AccessRequestStatus,
    pub requested_at: Timestamp,
    pub resolved_by: Option<Identity>,
    pub resolved_at: Option<Timestamp>,
}
