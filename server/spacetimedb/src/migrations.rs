//! `MigrationState` table + the standardised `run_pending_migrations`
//! reducer and its backfills. Lifecycle calls `run_pending_migrations`
//! after every successful `publish_module`.

use sha2::{Digest, Sha256};
use spacetimedb::{reducer, table, ReducerContext, Table, Timestamp};

use crate::harness::{harness_template, HarnessTemplate};
use crate::pages::{page, Page};
use crate::sensors::seed_sensor_registry_inner;
/// Records which one-shot data migrations have already run on this database.
///
/// CONTRACT: lifecycle's provisioner calls `run_pending_migrations` after
/// every successful `publish_module` (both new provisions and version
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
// CONTRACT (lifecycle ↔ pear module):
//
//   After every successful `publish_module` call (both fresh provisions
//   and version upgrades), pear-cloud's lifecycle calls the
//   `run_pending_migrations` reducer with the workspace's admin token.
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
// Failure of any step short-circuits the whole reducer — the next tick of
// the lifecycle upgrader will retry. State is committed per-step, so a
// partial failure doesn't roll back already-completed migrations.

/// Standardised post-publish hook called by lifecycle after every
/// `publish_module`. Idempotent and safe to call repeatedly. Adds new
/// `MigrationState` rows for any unfinished migrations.
#[reducer]
pub fn run_pending_migrations(ctx: &ReducerContext) -> Result<(), String> {
    macro_rules! run_step {
        ($ctx:expr, $key:expr, $body:expr) => {{
            let key: &str = $key;
            if $ctx.db.migration_state().key().find(&key.to_string()).is_none() {
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

    run_step!(ctx, "page_parent_pk_backfill_v1", backfill_page_parent_pk_inner);
    run_step!(ctx, "sensor_registry_seed_v1", |ctx: &ReducerContext| {
        seed_sensor_registry_inner(ctx);
        Ok::<(), String>(())
    });
    run_step!(
        ctx,
        "harness_template_external_id_backfill_v1",
        backfill_harness_template_external_id_inner
    );
    Ok(())
}

/// Backfill `HarnessTemplate.external_id` for rows that predate the field.
/// Empty strings are replaced with a deterministic hash over the template's
/// `(source, name, created_at)` so re-running is a no-op.
fn backfill_harness_template_external_id_inner(
    ctx: &ReducerContext,
) -> Result<(), String> {
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
        hasher.update(
            tmpl.created_at
                .to_micros_since_unix_epoch()
                .to_le_bytes(),
        );
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
