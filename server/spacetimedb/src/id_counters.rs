//! Per-table id allocator backed by a single counter row per table.
//!
//! Replaces the historical `iter().max() + 1` pattern (which was O(N) per
//! insert) with a single primary-key lookup + update on the `id_counter`
//! table. The counter row is created lazily on first allocation, seeded
//! from the current `max(id)` of the owning table — so existing
//! deployments migrate transparently with one O(N) scan per table per
//! cold start.
//!
//! This is the pattern SpacetimeDB's own docs recommend for
//! "guaranteed sequential values without gaps" (see Auto-Increment
//! docs / "Concurrency and Gaps"). We prefer it over `#[auto_inc]`
//! because:
//!
//! * `#[auto_inc]` only advances when callers insert with `id = 0`. The
//!   pre-existing data in this database was written with non-zero ids
//!   (via the legacy `next_*_id` helpers), so every table's internal
//!   sequence is still at its start value. Switching cold to `id = 0`
//!   would immediately collide with existing rows. The counter table
//!   sidesteps that landmine.
//! * Counter values are gap-free; `auto_inc` skips up to 4096 values
//!   per restart due to its batched persistence strategy.
//! * Migration is implicit and reversible — drop the counter rows and
//!   the next allocation re-seeds.

use spacetimedb::{table, ReducerContext, Table};

/// One row per "id namespace" — typically one per table, keyed by the
/// table's accessor name (e.g. `"page"`, `"conversation_message"`).
///
/// `value` is the **last allocated** id; the next allocation returns
/// `value + 1`. Seeded from `max(existing_id)` on first use after
/// deploy.
#[table(accessor = id_counter, public)]
pub struct IdCounter {
    #[primary_key]
    pub name: String,
    pub value: u64,
}

/// Allocate the next id for the named counter, seeding from the
/// supplied closure if the counter row does not yet exist.
///
/// `seed_from_existing` is called **at most once per database lifetime
/// per counter** (on first allocation after deploy). It must return the
/// current `max(id)` of the owning table so subsequent allocations do
/// not collide with rows written by the legacy `iter().max() + 1`
/// pattern.
pub(crate) fn alloc_id<F: FnOnce() -> u64>(
    ctx: &ReducerContext,
    name: &str,
    seed_from_existing: F,
) -> u64 {
    let key = name.to_string();
    let existing = ctx.db.id_counter().name().find(key.clone());
    let (counter, present) = match existing {
        Some(row) => (row, true),
        None => (
            IdCounter {
                name: key,
                value: seed_from_existing(),
            },
            false,
        ),
    };
    let next = counter.value + 1;
    let updated = IdCounter { value: next, ..counter };
    if present {
        ctx.db.id_counter().name().update(updated);
    } else {
        ctx.db.id_counter().insert(updated);
    }
    next
}
