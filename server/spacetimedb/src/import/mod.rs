//! Snapshot importers.
//!
//! One module per source format. Each importer is self-contained and
//! exposes its own `#[reducer]` entry points (`pear_v1` has a single
//! blob reducer; `pear_v2` is chunked: begin / chunk / commit / abort).
//! The `__pear`-tagged decode helpers shared by both pear formats live
//! in `decode`; `notion_v1` keeps its own decoders since its wire
//! envelope (Notion's UUID strings) barely overlaps.

mod decode;
pub(crate) mod notion_v1;
pub(crate) mod pear_v1;
pub(crate) mod pear_v2;
