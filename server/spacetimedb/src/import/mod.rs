//! Snapshot importers.
//!
//! One module per source format. Each importer is self-contained and
//! exposes a single `#[reducer]` entry point. Format-agnostic helpers
//! (if any meaningful set ever emerges) belong here at the module
//! root; for now both formats keep their own decoders since the wire
//! envelopes (e.g. `__pear`-tagged values vs. Notion's UUID strings)
//! barely overlap.

pub(crate) mod notion_v1;
pub(crate) mod pear_v1;
