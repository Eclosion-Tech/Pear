//! Cross-cutting custom types shared by multiple subsystem modules.

use spacetimedb::{Identity, SpacetimeType};

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ActorType {
    Human,
    Agent(String),
}

/// Access permission level on a Page or Block.
///
/// `Write` implies `Read` — a principal that can write necessarily can also
/// read. The two variants exist so rule storage stays compact (one row per
/// principal, not per action).
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum Permission {
    Read,
    Write,
}

/// A grantee on an access rule. Today only `WorkspaceMember(Identity)` is
/// populated; future variants (`EndUser(u64)`, etc.) can be appended without
/// migrating existing rows because SpacetimeDB enums are forward-compatible
/// when only adding variants. See PEAR_PROGRAMMING.md "Foundational
/// decisions" #2 for the rationale.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum Principal {
    /// A workspace member identified by their SpacetimeDB Identity.
    WorkspaceMember(Identity),
    // Future: EndUser(u64), ApiKey(u64), ServiceAccount(u64), ...
}
