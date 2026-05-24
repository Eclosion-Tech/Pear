//! Component tree substrate — the universal document model.
//!
//! See `docs/PEAR_COMPONENT_NODE_SCHEMA.md` for the ADR this file implements.
//!
//! The substrate has three tables:
//!
//! - [`ComponentNode`] — one row per node in a component tree. Tree shape is
//!   encoded via `parent_id` + `order`. Every Page that's been migrated to
//!   `PageContentFormat::ComponentTree` owns a tree of these.
//! - [`ComponentYjsState`] — block-scoped Yjs blob. 1:1 with the `RichText`
//!   (or other Yjs-backed) `ComponentNode` that owns it. Per-block, not
//!   per-page — that's the resolution of `PEAR_RENDERING_SUBSTRATE.md` open
//!   question #5.
//! - [`ComponentTypeDefinition`] — the type registry. Seeded with built-ins at
//!   init; extensible via [`register_component_type`] for tier-5 component
//!   packs (post-v1).
//!
//! Sprint 1 (this file) ships the schema, enums, and seed. Mutation reducers
//! (`insert_component`, `update_component_props`, `move_component`,
//! `delete_component`, `restore_component`, `save_component_yjs_state`,
//! `register_component_type`, `update_component_type`) land in sprint 2.

use spacetimedb::{table, Identity, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::id_counters::alloc_id;
use crate::module_install::module_install_meta;
use crate::types::ActorType;

// ============================================================
// Enums
// ============================================================

/// Coarse-grained authority declared by a component type. Lives on the
/// registry entry, not the instance — see `PEAR_COMPONENT_NODE_SCHEMA.md`
/// open question #7 resolution.
///
/// The enum is small by design. Its job is to give the harness layer
/// (review agents, audit log, AI permission scoping) a summary it can
/// reason about without traversing the prop graph of every node.
#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq, Hash)]
pub enum ComponentCapability {
    ReadsDatabase,
    ReadsProperty,
    WritesDatabase,
    WritesProperty,
    DeletesRow,
    NavigatesToPage,
    OpensExternalUrl,
    TriggersAutomation,
}

/// Discriminator for how a Page stores its content during the BlockNote →
/// component-tree migration window. Once every page in the workspace is
/// `ComponentTree` and the legacy reducers are removed, this enum becomes
/// vestigial and can be dropped.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum PageContentFormat {
    /// Legacy: content lives in `PageContent.content` (BlockNote JSON) and
    /// `PageYjsState.data` (single merged Yjs blob).
    BlockNote,
    /// Current: content lives in `ComponentNode` rows scoped to this page,
    /// with per-RichText Yjs bytes in `ComponentYjsState`.
    ComponentTree,
}

// ============================================================
// Tables
// ============================================================

/// The universal substrate atom for rendered content. One row per node in
/// the tree; tree shape via `parent_id` + `order`. Every node belongs to
/// exactly one Surface (today: `Page.id`).
///
/// See `docs/PEAR_COMPONENT_NODE_SCHEMA.md` § Schema.
#[table(
    accessor = component_node,
    public,
    index(
        accessor = component_node_by_surface_parent,
        btree(columns = [surface_id, parent_id])
    )
)]
pub struct ComponentNode {
    #[primary_key]
    pub id: u64,

    /// The Surface (`Page.id` today) this node belongs to. Forward-compatible
    /// with custom-view Surfaces that aren't Pages — see open question #1
    /// in the schema ADR.
    #[index(btree)]
    pub surface_id: u64,

    /// Tree position. `None` = root node. Exactly one root per Surface.
    #[index(btree)]
    pub parent_id: Option<u64>,

    /// Looked up in [`ComponentTypeDefinition`]. Reducers reject unknown
    /// types.
    pub component_type: String,

    /// JSON-encoded props. Validated against
    /// [`ComponentTypeDefinition::prop_schema`] on the client today;
    /// server-side enforcement is post-v1 (see ADR § Prop-schema validation).
    /// Empty `{}` for components with no props. Does NOT include Yjs bytes
    /// for `RichText` — those live in [`ComponentYjsState`].
    pub props: String,

    /// Sibling order under `parent_id`. Spaced by 1000 (same convention as
    /// `Page.sort_order`) so insertions rarely need a renumber.
    pub order: u32,

    pub created_by: ActorType,
    pub updated_by: ActorType,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,

    /// Soft-delete. Matches the `Page` pattern; enables undo via
    /// `restore_component`. Hard-purged alongside the owning Page by the
    /// existing `purge_page_inner`.
    pub deleted_at: Option<Timestamp>,
}

/// Block-scoped Yjs state. One row per Yjs-backed [`ComponentNode`]
/// (typically `RichText`). Non-Yjs components have no row here.
///
/// During the BlockNote → component-tree migration, the legacy per-page
/// `PageYjsState` continues to serve `BlockNote`-format pages. Once all
/// pages are converted, `PageYjsState` is removed.
#[table(accessor = component_yjs_state, public)]
pub struct ComponentYjsState {
    /// The `ComponentNode` this Yjs doc belongs to (1:1).
    #[primary_key]
    pub component_node_id: u64,

    /// Full merged Yjs state (`Y.encodeStateAsUpdate` output). Client writes
    /// the whole blob on blur / unmount / ~30 s tick — same cadence as the
    /// existing `PageYjsState` pattern.
    pub data: Vec<u8>,

    pub updated_at: Timestamp,
}

/// The component registry. Seeded with built-in types by
/// [`seed_builtin_component_types`] at init. Tier-5 extensions register
/// additional types via the (sprint-2) `register_component_type` reducer;
/// built-ins are immutable.
#[table(accessor = component_type_definition, public)]
pub struct ComponentTypeDefinition {
    #[primary_key]
    pub id: u64,

    /// The string used by `ComponentNode.component_type` to look up this
    /// entry. E.g. `"Container"`, `"RichText"`, `"Form"`, `"CodeRef"`.
    #[unique]
    pub component_type: String,

    /// Human-facing label and description for registry browsers and AI
    /// component-pickers. Display-only — code keys on `component_type`.
    pub display_name: String,
    pub description: String,

    /// JSON Schema for `ComponentNode.props` validation. Stored even though
    /// server-side enforcement is post-v1, so the client validation surface
    /// has a single source of truth and future server-side validation has
    /// nothing to retrofit.
    pub prop_schema: String,

    /// Declared capabilities for this component type. Coarse-grained;
    /// see [`ComponentCapability`].
    pub capabilities: Vec<ComponentCapability>,

    /// Whether this component holds Yjs state in [`ComponentYjsState`].
    /// True for `RichText`; false for layout / binding / button components.
    pub has_yjs_state: bool,

    /// Whether this component accepts child `ComponentNode` rows.
    pub accepts_children: bool,

    /// True for init-seeded built-ins. Sprint-2 reducers refuse to modify
    /// or delete these. Tier-5 user-registered types are mutable by their
    /// registering identity.
    pub is_builtin: bool,

    /// Identity that registered this type. Built-ins use the publisher
    /// identity recorded by `module_install`.
    pub registered_by: Identity,

    pub created_at: Timestamp,
}

// ============================================================
// Id allocators
// ============================================================

/// Allocator for `ComponentNode.id`. Unused in sprint 1 (schema only);
/// called by `insert_component` when the mutation reducers land in sprint 2.
#[allow(dead_code)]
pub(crate) fn next_component_node_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "component_node", || {
        ctx.db.component_node().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_component_type_definition_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "component_type_definition", || {
        ctx.db
            .component_type_definition()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

// ============================================================
// Built-in registry seed
// ============================================================

/// Prop schemas for the v1 built-in components. JSON Schema today; namespace-
/// prefixed extensions (e.g. `"$pear:propertyRef"`) can be added later
/// without changing the storage format.
mod prop_schemas {
    pub const CONTAINER: &str = r#"{
  "type": "object",
  "properties": {
    "layout": { "enum": ["flex", "grid", "stack"] },
    "direction": { "enum": ["row", "column"] },
    "gap": { "type": "number" },
    "padding": { "type": "number" },
    "backgroundColor": { "type": "string" }
  },
  "required": ["layout"]
}"#;

    pub const RICH_TEXT: &str = r#"{
  "type": "object",
  "properties": {
    "placeholder": { "type": "string" },
    "maxLength": { "type": "number" },
    "markWhitelist": { "type": "array", "items": { "type": "string" } }
  }
}"#;

    pub const HEADING: &str = r#"{
  "type": "object",
  "properties": {
    "level": { "type": "integer", "minimum": 1, "maximum": 6 },
    "text": { "type": "string" }
  },
  "required": ["level", "text"]
}"#;

    pub const IMAGE: &str = r#"{
  "type": "object",
  "properties": {
    "attachmentId": { "type": "integer" },
    "alt": { "type": "string" },
    "width": { "type": "number" },
    "height": { "type": "number" }
  },
  "required": ["attachmentId"]
}"#;

    pub const FORM: &str = r#"{
  "type": "object",
  "properties": {
    "databaseId": { "type": "integer" },
    "cursor": {
      "type": "object",
      "properties": {
        "mode": { "enum": ["new", "single", "filtered"] }
      },
      "required": ["mode"]
    },
    "submitLabel": { "type": "string" }
  },
  "required": ["databaseId", "cursor"]
}"#;

    pub const INPUT: &str = r#"{
  "type": "object",
  "properties": {
    "propertyDefinitionId": { "type": "integer" },
    "label": { "type": "string" },
    "placeholder": { "type": "string" },
    "required": { "type": "boolean" }
  },
  "required": ["propertyDefinitionId"]
}"#;

    pub const BUTTON: &str = r#"{
  "type": "object",
  "properties": {
    "label": { "type": "string" },
    "variant": { "enum": ["primary", "secondary", "danger", "ghost"] },
    "action": {
      "type": "object",
      "properties": {
        "type": {
          "enum": [
            "submit_form",
            "navigate",
            "open_url",
            "trigger_automation",
            "create_row",
            "delete_row",
            "write_property"
          ]
        }
      },
      "required": ["type"]
    }
  },
  "required": ["label", "action"]
}"#;

    pub const TABLE: &str = r#"{
  "type": "object",
  "properties": {
    "databaseId": { "type": "integer" },
    "viewId": { "type": "integer" },
    "columns": { "type": "array", "items": { "type": "integer" } }
  },
  "required": ["databaseId"]
}"#;

    pub const CARD: &str = r#"{
  "type": "object",
  "properties": {
    "dataSource": {
      "type": "object",
      "properties": {
        "databaseId": { "type": "integer" },
        "cursor": { "type": "object" }
      },
      "required": ["databaseId"]
    }
  },
  "required": ["dataSource"]
}"#;

    pub const LIST: &str = r#"{
  "type": "object",
  "properties": {
    "dataSource": {
      "type": "object",
      "properties": {
        "databaseId": { "type": "integer" },
        "cursor": { "type": "object" }
      },
      "required": ["databaseId"]
    }
  },
  "required": ["dataSource"]
}"#;

    pub const CODE_REF: &str = r#"{
  "type": "object",
  "properties": {
    "repo": {
      "type": "object",
      "properties": {
        "kind": { "enum": ["git_remote", "local_path"] },
        "url": { "type": "string" },
        "path": { "type": "string" }
      },
      "required": ["kind"]
    },
    "ref": { "type": "string" },
    "path": { "type": "string" },
    "range": {
      "type": "object",
      "properties": {
        "startLine": { "type": "integer" },
        "endLine": { "type": "integer" }
      }
    },
    "symbol": { "type": "string" },
    "snapshot": { "type": "object" }
  },
  "required": ["repo", "ref", "path"]
}"#;
}

/// One row in the to-be-seeded registry. Tuple form keeps the seed call site
/// compact; expanded into a `ComponentTypeDefinition` insert below.
struct BuiltinSpec {
    component_type: &'static str,
    display_name: &'static str,
    description: &'static str,
    prop_schema: &'static str,
    capabilities: Vec<ComponentCapability>,
    has_yjs_state: bool,
    accepts_children: bool,
}

fn builtin_specs() -> Vec<BuiltinSpec> {
    use ComponentCapability::*;
    vec![
        BuiltinSpec {
            component_type: "Container",
            display_name: "Container",
            description: "Layout container with flex / grid / stack modes.",
            prop_schema: prop_schemas::CONTAINER,
            capabilities: vec![],
            has_yjs_state: false,
            accepts_children: true,
        },
        BuiltinSpec {
            component_type: "RichText",
            display_name: "Rich text",
            description: "Inline rich-text leaf. Delegates editing to y-prosemirror on web and @eclosion-tech/react-native-yjs-text on mobile.",
            prop_schema: prop_schemas::RICH_TEXT,
            capabilities: vec![],
            has_yjs_state: true,
            accepts_children: false,
        },
        BuiltinSpec {
            component_type: "Heading",
            display_name: "Heading",
            description: "Heading with level + inline text. Not Yjs-backed at v1 — flip has_yjs_state if heading co-editing becomes a priority.",
            prop_schema: prop_schemas::HEADING,
            capabilities: vec![],
            has_yjs_state: false,
            accepts_children: false,
        },
        BuiltinSpec {
            component_type: "Image",
            display_name: "Image",
            description: "Image reference via Attachment.",
            prop_schema: prop_schemas::IMAGE,
            capabilities: vec![],
            has_yjs_state: false,
            accepts_children: false,
        },
        BuiltinSpec {
            component_type: "Form",
            display_name: "Form",
            description: "Data-bound form that writes to a DatabaseSchema on submit.",
            prop_schema: prop_schemas::FORM,
            capabilities: vec![WritesDatabase],
            has_yjs_state: false,
            accepts_children: true,
        },
        BuiltinSpec {
            component_type: "Input",
            display_name: "Input",
            description: "Form-leaf input with typed propertyRef binding.",
            prop_schema: prop_schemas::INPUT,
            capabilities: vec![ReadsProperty, WritesProperty],
            has_yjs_state: false,
            accepts_children: false,
        },
        BuiltinSpec {
            component_type: "Button",
            display_name: "Button",
            description: "Action trigger. Declared capability set is the superset of what Button.action.type can invoke; per-instance narrowing is a follow-up.",
            prop_schema: prop_schemas::BUTTON,
            capabilities: vec![
                WritesProperty,
                WritesDatabase,
                DeletesRow,
                NavigatesToPage,
                OpensExternalUrl,
                TriggersAutomation,
            ],
            has_yjs_state: false,
            accepts_children: false,
        },
        BuiltinSpec {
            component_type: "Table",
            display_name: "Table",
            description: "Database view embedded as a component.",
            prop_schema: prop_schemas::TABLE,
            capabilities: vec![ReadsDatabase],
            has_yjs_state: false,
            accepts_children: false,
        },
        BuiltinSpec {
            component_type: "Card",
            display_name: "Card",
            description: "Data-bound card layout — one row per render.",
            prop_schema: prop_schemas::CARD,
            capabilities: vec![ReadsDatabase, ReadsProperty],
            has_yjs_state: false,
            accepts_children: true,
        },
        BuiltinSpec {
            component_type: "List",
            display_name: "List",
            description: "Iterator over database rows; renders child components per row.",
            prop_schema: prop_schemas::LIST,
            capabilities: vec![ReadsDatabase, ReadsProperty],
            has_yjs_state: false,
            accepts_children: true,
        },
        BuiltinSpec {
            component_type: "CodeRef",
            display_name: "Code reference",
            description: "Typed pointer to code in an external repository. Read-through is mediated by the outbound MCP server; no direct authority on the workspace substrate.",
            prop_schema: prop_schemas::CODE_REF,
            capabilities: vec![],
            has_yjs_state: false,
            accepts_children: false,
        },
    ]
}

/// Seed the built-in component type registry. Idempotent — skips if the
/// `Container` row already exists. Called from `init` after the publisher
/// identity has been recorded by [`ensure_publisher_identity_recorded`].
pub(crate) fn seed_builtin_component_types(ctx: &ReducerContext) {
    let already_seeded = ctx
        .db
        .component_type_definition()
        .component_type()
        .find("Container".to_string())
        .is_some();
    if already_seeded {
        return;
    }

    let publisher_identity = ctx
        .db
        .module_install_meta()
        .id()
        .find(0)
        .map(|m| m.publisher_identity)
        .unwrap_or_else(|| ctx.sender());

    for spec in builtin_specs() {
        ctx.db.component_type_definition().insert(ComponentTypeDefinition {
            id: next_component_type_definition_id(ctx),
            component_type: spec.component_type.to_string(),
            display_name: spec.display_name.to_string(),
            description: spec.description.to_string(),
            prop_schema: spec.prop_schema.to_string(),
            capabilities: spec.capabilities,
            has_yjs_state: spec.has_yjs_state,
            accepts_children: spec.accepts_children,
            is_builtin: true,
            registered_by: publisher_identity,
            created_at: ctx.timestamp,
        });
    }
}
