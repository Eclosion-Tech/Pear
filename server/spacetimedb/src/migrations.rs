//! `MigrationState` table + the standardised `run_pending_migrations`
//! reducer and its backfills. Hosts typically invoke this reducer after each
//! successful `publish_module` (automation, CI, or manual operator flow).

use sha2::{Digest, Sha256};
use spacetimedb::{reducer, table, ReducerContext, Table, Timestamp};

use crate::access_control::helpers::{explicit_page_access_rule_allows, page_has_any_rule};
use crate::ai::ai_user_config;
use crate::ai::memory::{
    ai_user_memory, collect_live_subtree_page_ids, grant_ai_memory_creator_read,
    grant_ai_memory_page_access,
};
use crate::types::Permission;
use crate::automations::seed_automation_primitives_inner;
use crate::harness::{harness_template, HarnessTemplate};
use crate::module_install::ensure_publisher_identity_recorded;
use crate::pages::components::seed_builtin_component_types;
use crate::pages::components::migrate_heading_yjs_registry_v1;
use crate::pages::{page, Page};
use crate::sensors::seed_sensor_registry_inner;
/// Records which one-shot data migrations have already run on this database.
///
/// CONTRACT: whoever publishes this WASM should call `run_pending_migrations`
/// after every successful `publish_module` (fresh database and version
/// upgrades). The reducer is responsible for deciding what's new based on
/// rows in this table — it MUST NOT re-run a migration whose key is
/// already recorded. See `run_pending_migrations` for the canonical list.
///
/// Keys are free-form strings (e.g. `"page_parent_pk_backfill_v1"`) and
/// MUST be unique-and-stable across releases — once recorded, the same
/// key will never re-run, so changing data semantics requires a new key.
#[table(accessor = migration_state, public)]
pub struct MigrationState {
    #[primary_key]
    pub key: String,
    pub completed_at: Timestamp,
    /// Module version (`Cargo.toml`'s `[package].version`) that introduced
    /// this migration. Stored for forensics — not used for dispatch.
    pub module_version: String,
}

// ----------------------------------------------------------------------
// Migrations: standardised post-upgrade hook
// ----------------------------------------------------------------------
//
// CONTRACT (host ↔ module):
//
//   After every successful `publish_module` (fresh database and version
//   upgrades), invoke `run_pending_migrations` with credentials that can
//   run privileged reducers for this database (often the module publisher).
//
//   Each migration step:
//     1. Has a stable, unique key (string).
//     2. Checks `MigrationState` for that key — skips if already recorded.
//     3. Runs its work (typically a backfill or one-shot data transform).
//     4. Inserts a `MigrationState` row to mark itself complete.
//
// Keys are append-only — once shipped, NEVER rename or re-use one. To
// re-run the SAME logic on already-migrated databases, define a new key
// with a `_v2` suffix.
//
// New migrations are added by:
//   - Implementing the body as a private `fn` returning `Result<(), String>`.
//   - Appending a `run_step!(ctx, "<key>", <fn>);` line to
//     `run_pending_migrations` below.
//
// Failure of any step short-circuits the whole reducer — the next scheduled
// or manual retry will run again. State is committed per-step, so a
// partial failure doesn't roll back already-completed migrations.

/// Standardised post-publish hook: call after each successful
/// `publish_module`. Idempotent and safe to call repeatedly. Adds new
/// `MigrationState` rows for any unfinished migrations.
#[reducer]
pub fn run_pending_migrations(ctx: &ReducerContext) -> Result<(), String> {
    macro_rules! run_step {
        ($ctx:expr, $key:expr, $body:expr) => {{
            let key: &str = $key;
            if $ctx
                .db
                .migration_state()
                .key()
                .find(&key.to_string())
                .is_none()
            {
                $body($ctx)?;
                $ctx.db.migration_state().insert(MigrationState {
                    key: key.to_string(),
                    completed_at: $ctx.timestamp,
                    module_version: env!("CARGO_PKG_VERSION").to_string(),
                });
                log::info!("migration completed: {key}");
            }
        }};
    }

    run_step!(
        ctx,
        "page_parent_pk_backfill_v1",
        backfill_page_parent_pk_inner
    );
    run_step!(ctx, "sensor_registry_seed_v1", |ctx: &ReducerContext| {
        seed_sensor_registry_inner(ctx);
        Ok::<(), String>(())
    });
    run_step!(
        ctx,
        "automation_primitive_registry_seed_v1",
        |ctx: &ReducerContext| {
            seed_automation_primitives_inner(ctx);
            Ok::<(), String>(())
        }
    );
    run_step!(
        ctx,
        "harness_template_external_id_backfill_v1",
        backfill_harness_template_external_id_inner
    );
    run_step!(
        ctx,
        "ai_user_memory_private_access_v1",
        backfill_ai_user_memory_private_access_inner
    );
    run_step!(
        ctx,
        "module_install_meta_publisher_v1",
        |ctx: &ReducerContext| {
            ensure_publisher_identity_recorded(ctx);
            Ok::<(), String>(())
        }
    );
    run_step!(
        ctx,
        "component_type_registry_seed_v1",
        |ctx: &ReducerContext| {
            seed_builtin_component_types(ctx);
            Ok::<(), String>(())
        }
    );
    run_step!(
        ctx,
        "component_type_sprint4_builtins_v1",
        |ctx: &ReducerContext| {
            seed_builtin_component_types(ctx);
            Ok::<(), String>(())
        }
    );
    run_step!(
        ctx,
        "component_type_document_lists_v1",
        |ctx: &ReducerContext| {
            seed_builtin_component_types(ctx);
            Ok::<(), String>(())
        }
    );
    run_step!(
        ctx,
        "component_type_markdown_table_v1",
        |ctx: &ReducerContext| {
            seed_builtin_component_types(ctx);
            Ok::<(), String>(())
        }
    );
    run_step!(
        ctx,
        "component_heading_yjs_registry_v1",
        |ctx: &ReducerContext| {
            migrate_heading_yjs_registry_v1(ctx);
            Ok::<(), String>(())
        }
    );
    // Re-apply the current Heading definition so existing workspaces pick up
    // the `section` prop added to `prop_schemas::HEADING` (collapsible-section
    // headings). `migrate_heading_yjs_registry_v1` reassigns the live row to
    // the current builtin schema — idempotent to re-run under a new step.
    run_step!(
        ctx,
        "component_heading_section_prop_v1",
        |ctx: &ReducerContext| {
            migrate_heading_yjs_registry_v1(ctx);
            Ok::<(), String>(())
        }
    );
    run_step!(
        ctx,
        "bridge_device_summary_backfill_v1",
        backfill_bridge_device_summary_inner
    );
    run_step!(
        ctx,
        "bridge_device_grant_backfill_v1",
        backfill_bridge_device_grants_inner
    );
    run_step!(
        ctx,
        "ai_user_memory_creator_read_v1",
        backfill_ai_user_memory_creator_read_inner
    );
    Ok(())
}

/// Grant each AI user's human creator read access to its memory root, so a
/// non-admin creator can inspect/correct the AI's memory. Before this, the
/// AI-only rule locked the creator out of the memory they're accountable for.
/// A rule on the root covers the whole subtree; idempotent — skips a root the
/// creator can already read.
fn backfill_ai_user_memory_creator_read_inner(ctx: &ReducerContext) -> Result<(), String> {
    let mut n = 0u64;
    for mem in ctx.db.ai_user_memory().iter() {
        let Some(cfg) = ctx.db.ai_user_config().id().find(mem.ai_user_id) else {
            continue;
        };
        if cfg.created_by == cfg.identity {
            continue;
        }
        if explicit_page_access_rule_allows(ctx, mem.root_page_id, cfg.created_by, &Permission::Read)
        {
            continue;
        }
        grant_ai_memory_creator_read(ctx, mem.root_page_id, cfg.created_by);
        n += 1;
    }
    log::info!("ai_user_memory_creator_read_v1: added creator-read rules on {n} memory roots");
    Ok(())
}

/// Backfill `BridgeDeviceGrant` rows so the default-deny boundary added to
/// `enqueue_bridge_command` does not break workspaces that were using
/// `tool-bash` before grants existed. Before this change, any AI user could run
/// `tool-bash` on any device in the workspace; this preserves that *effective*
/// access by granting every existing AI user every existing (non-revoked)
/// device — but now as explicit, owner-revocable rows. New devices/AI users
/// start with no grants (default-deny), which is the intended posture going
/// forward. `granted_by` is set to the device owner.
fn backfill_bridge_device_grants_inner(ctx: &ReducerContext) -> Result<(), String> {
    use crate::bridge::{
        bridge_device, bridge_device_grant, next_bridge_device_grant_id, BridgeDeviceGrant,
    };
    let ai_user_identities: Vec<spacetimedb::Identity> =
        ctx.db.ai_user_config().iter().map(|u| u.identity).collect();
    if ai_user_identities.is_empty() {
        return Ok(());
    }
    let mut inserted = 0u64;
    for device in ctx.db.bridge_device().iter().filter(|d| d.revoked_at.is_none()) {
        for ai_user_identity in &ai_user_identities {
            let already = ctx
                .db
                .bridge_device_grant()
                .device_id()
                .filter(device.id)
                .any(|g| g.ai_user_identity == *ai_user_identity);
            if already {
                continue;
            }
            ctx.db.bridge_device_grant().insert(BridgeDeviceGrant {
                id: next_bridge_device_grant_id(ctx),
                device_id: device.id,
                ai_user_identity: *ai_user_identity,
                granted_by: device.owner,
                granted_at: ctx.timestamp,
            });
            inserted += 1;
        }
    }
    log::info!("bridge_device_grant_backfill_v1: inserted {inserted} grants");
    Ok(())
}

/// Seed the public `bridge_device_summary` mirror for devices paired before the
/// table existed, so they appear in `list_bridge_devices`. `connected` starts
/// false and is corrected the next time the device opens a relay session.
fn backfill_bridge_device_summary_inner(ctx: &ReducerContext) -> Result<(), String> {
    use crate::bridge::{bridge_device, bridge_device_summary, BridgeDeviceSummary};
    let existing: std::collections::HashSet<u64> =
        ctx.db.bridge_device_summary().iter().map(|s| s.id).collect();
    let missing: Vec<_> = ctx
        .db
        .bridge_device()
        .iter()
        .filter(|d| !existing.contains(&d.id))
        .collect();
    let n = missing.len();
    for d in missing {
        ctx.db.bridge_device_summary().insert(BridgeDeviceSummary {
            id: d.id,
            name: d.name.clone(),
            platform: d.platform.clone(),
            connected: false,
            revoked_at: d.revoked_at,
        });
    }
    log::info!("bridge_device_summary_backfill_v1: inserted {n} rows");
    Ok(())
}

/// Adds `page_access_rule` rows for existing AI memory subtrees that were created
/// under the open default (only `is_hidden` hid them from nav — not access control).
fn backfill_ai_user_memory_private_access_inner(ctx: &ReducerContext) -> Result<(), String> {
    let mut n = 0u64;
    for mem in ctx.db.ai_user_memory().iter() {
        let cfg = ctx
            .db
            .ai_user_config()
            .id()
            .find(mem.ai_user_id)
            .ok_or_else(|| {
                format!(
                    "ai_user_memory references missing ai_user_id={}",
                    mem.ai_user_id
                )
            })?;
        for pid in collect_live_subtree_page_ids(ctx, mem.root_page_id) {
            if page_has_any_rule(ctx, pid) {
                continue;
            }
            grant_ai_memory_page_access(ctx, pid, cfg.identity);
            n += 1;
        }
    }
    log::info!("ai_user_memory_private_access_v1: added rules on {n} pages");
    Ok(())
}

/// Backfill `HarnessTemplate.external_id` for rows that predate the field.
/// Empty strings are replaced with a deterministic hash over the template's
/// `(source, name, created_at)` so re-running is a no-op.
fn backfill_harness_template_external_id_inner(ctx: &ReducerContext) -> Result<(), String> {
    let stale: Vec<HarnessTemplate> = ctx
        .db
        .harness_template()
        .iter()
        .filter(|t| t.external_id.is_empty())
        .collect();
    let n = stale.len();
    for tmpl in stale {
        let mut hasher = Sha256::new();
        hasher.update(format!("{:?}", tmpl.source).as_bytes());
        hasher.update(b"\x00");
        hasher.update(tmpl.name.as_bytes());
        hasher.update(b"\x00");
        hasher.update(tmpl.created_at.to_micros_since_unix_epoch().to_le_bytes());
        let external_id = hex::encode(hasher.finalize());
        ctx.db.harness_template().id().update(HarnessTemplate {
            external_id,
            ..tmpl
        });
    }
    log::info!("harness_template_external_id_backfill_v1: updated {n} rows");
    Ok(())
}

/// Backfill `Page.parent_pk` from `Page.parent_id` for rows that predate
/// the field. Skips soft-deleted pages (the API gateway never queries
/// them) so the on-disk diff stays small.
fn backfill_page_parent_pk_inner(ctx: &ReducerContext) -> Result<(), String> {
    let stale: Vec<Page> = ctx
        .db
        .page()
        .iter()
        .filter(|p| p.deleted_at.is_none() && p.parent_pk != p.parent_id.unwrap_or(0))
        .collect();

    let n = stale.len();
    for page in stale {
        let parent_pk = page.parent_id.unwrap_or(0);
        ctx.db.page().id().update(Page { parent_pk, ..page });
    }
    log::info!("page_parent_pk_backfill_v1: updated {n} rows");
    Ok(())
}
