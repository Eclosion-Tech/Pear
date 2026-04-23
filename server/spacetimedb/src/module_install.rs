//! Install metadata: records the database publisher identity for authorization.
//!
//! SpacetimeDB passes the publisher as `ctx.sender()` in `#[reducer(init)]`. The
//! same identity is used when invoking reducers via the publisher HTTP API.
//! Hosts that delegate management to a gateway can rely on this check without
//! embedding product-specific logic in the module.

use spacetimedb::{table, Identity, ReducerContext, Table};

/// Singleton row (`id` is always `0`) holding the publisher identity for this database.
#[table(accessor = module_install_meta, public)]
pub struct ModuleInstallMeta {
    #[primary_key]
    pub id: u8,
    pub publisher_identity: Identity,
}

/// Writes [`ModuleInstallMeta`] on first run using `ctx.sender()` as the publisher.
///
/// Call from `init` and from one-shot migrations so existing databases backfill
/// when this table is first added.
pub(crate) fn ensure_publisher_identity_recorded(ctx: &ReducerContext) {
    if ctx.db.module_install_meta().id().find(0).is_none() {
        ctx.db.module_install_meta().insert(ModuleInstallMeta {
            id: 0,
            publisher_identity: ctx.sender(),
        });
    }
}

/// `true` when the caller identity matches the recorded publisher.
pub(crate) fn sender_is_module_publisher(ctx: &ReducerContext) -> bool {
    ctx.db
        .module_install_meta()
        .id()
        .find(0)
        .is_some_and(|m| m.publisher_identity == ctx.sender())
}
