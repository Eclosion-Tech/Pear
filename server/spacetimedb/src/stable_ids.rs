// ============================================================
// Cross-database stable IDs.
// ============================================================
// SHA-256 over (sender || NUL || timestamp_micros || NUL || kind || NUL ||
// extra) and hex-encoded. Deterministic for the same inputs but in
// practice unique because the timestamp component is always present.
// Used for entities (HarnessTemplate, etc.) that may travel between
// workspaces — `id` is a per-database surrogate and is unstable across
// imports, but `external_id` is the entity's true identity.

use sha2::{Digest, Sha256};
use spacetimedb::ReducerContext;

pub(crate) fn generate_external_id(ctx: &ReducerContext, kind: &str, extra: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{:?}", ctx.sender()).as_bytes());
    hasher.update(b"\x00");
    hasher.update(
        ctx.timestamp
            .to_micros_since_unix_epoch()
            .to_le_bytes(),
    );
    hasher.update(b"\x00");
    hasher.update(kind.as_bytes());
    hasher.update(b"\x00");
    hasher.update(extra.as_bytes());
    hex::encode(hasher.finalize())
}
