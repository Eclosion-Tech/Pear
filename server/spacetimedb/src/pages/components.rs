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
//! Sprint 1 shipped the schema, enums, and seed. Sprint 2 shipped the
//! tree-mutation reducers (`insert_component`, `update_component_props`,
//! `move_component`, `delete_component`, `restore_component`,
//! `save_component_yjs_state`) and the legacy-reducer guards in
//! `pages/mod.rs` that reject `ComponentTree`-format pages from the BlockNote
//! reducers. Sprint 3 (current) ships registry mutations
//! (`register_component_type`, `update_component_type`), the
//! `purge_component_tree` helper consumed by `purge_page_inner`, and the
//! `serialize_component_tree` / `restore_component_tree` helpers consumed
//! by the snapshot reducers in `pages/snapshots.rs`.

use spacetimedb::{reducer, table, Identity, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::access_control::helpers::require_page_write;
use crate::auth::user;
use crate::automations::enqueue_page_updated;
use crate::id_counters::alloc_id;
use crate::module_install::module_install_meta;
use crate::pages::{page, Page};
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
    ///
    /// The intended end state is a fractional-indexing `String` (see
    /// `docs/PEAR_COMPONENT_NODE_SCHEMA.md` § Sort key — fractional indexing,
    /// deferred). That swap is a column-type change SpacetimeDB requires a
    /// manual migration for, so it's parked until it can ride along with the
    /// BlockNote → `ComponentTree` migration tool, which already needs to
    /// rewrite this table.
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

/// Allocator for `ComponentNode.id`.
pub(crate) fn next_component_node_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "component_node", || {
        ctx.db
            .component_node()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
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
    "text": { "type": "string" },
    "textAlign": { "enum": ["left", "center", "right"] },
    "collapsed": { "type": "boolean" },
    "section": { "type": "boolean" }
  },
  "required": ["level"]
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

    /// BlockNote-era page link — stores cached title for instant render.
    pub const PAGE_LINK: &str = r#"{
  "type": "object",
  "properties": {
    "pageId": { "type": "string" },
    "pageTitle": { "type": "string" }
  },
  "required": ["pageId", "pageTitle"]
}"#;

    /// Inline conversation embed (Phase A AI integration).
    pub const CONVERSATION: &str = r#"{
  "type": "object",
  "properties": {
    "conversationId": { "type": "string" },
    "collapsed": { "type": "string" },
    "autoCollapseThresholdMinutes": { "type": "string" }
  },
  "required": ["conversationId"]
}"#;

    /// Audio recording / upload block (storageKey + optional transcript).
    pub const AUDIO: &str = r#"{
  "type": "object",
  "properties": {
    "storageKey": { "type": "string" },
    "transcript": { "type": "string" },
    "durationSec": { "type": "number" },
    "boot": { "type": "string" }
  }
}"#;

    /// Rich image block from BlockNote migration (storageKey + caption).
    /// Distinct from v1 `Image` (attachmentId) to keep migration 1:1.
    pub const IMAGE_BLOCK: &str = r#"{
  "type": "object",
  "properties": {
    "storageKey": { "type": "string" },
    "caption": { "type": "string" }
  }
}"#;

    /// Document-list item components. Text lives in per-item Yjs state;
    /// checklist state is a normal prop so toggles are structural writes.
    pub const BULLET_LIST_ITEM: &str = r#"{
  "type": "object",
  "properties": {
    "placeholder": { "type": "string" }
  }
}"#;

    pub const NUMBERED_LIST_ITEM: &str = r#"{
  "type": "object",
  "properties": {
    "placeholder": { "type": "string" }
  }
}"#;

    pub const CHECKLIST_ITEM: &str = r#"{
  "type": "object",
  "properties": {
    "checked": { "type": "boolean" },
    "placeholder": { "type": "string" }
  },
  "required": ["checked"]
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
            description: "Heading with level + Yjs-backed title text. Optional section container when nested blocks are present; collapse via props.collapsed.",
            prop_schema: prop_schemas::HEADING,
            capabilities: vec![],
            has_yjs_state: true,
            accepts_children: true,
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
        BuiltinSpec {
            component_type: "PageLink",
            display_name: "Page link",
            description: "Link to a child or sibling page. Cached title renders instantly from props; live subscription overrides on rename.",
            prop_schema: prop_schemas::PAGE_LINK,
            capabilities: vec![NavigatesToPage],
            has_yjs_state: false,
            accepts_children: false,
        },
        BuiltinSpec {
            component_type: "Conversation",
            display_name: "Conversation",
            description: "Inline AI conversation embed with collapsed preview and Open affordance.",
            prop_schema: prop_schemas::CONVERSATION,
            capabilities: vec![],
            has_yjs_state: false,
            accepts_children: false,
        },
        BuiltinSpec {
            component_type: "Audio",
            display_name: "Audio",
            description: "Audio recording or upload with optional live transcript.",
            prop_schema: prop_schemas::AUDIO,
            capabilities: vec![],
            has_yjs_state: false,
            accepts_children: false,
        },
        BuiltinSpec {
            component_type: "ImageBlock",
            display_name: "Image",
            description: "Uploaded image via workspace blob storage (BlockNote migration path). Distinct from v1 Image (attachmentId).",
            prop_schema: prop_schemas::IMAGE_BLOCK,
            capabilities: vec![],
            has_yjs_state: false,
            accepts_children: false,
        },
        BuiltinSpec {
            component_type: "BulletListItem",
            display_name: "Bullet list item",
            description: "Document bullet list item. Text lives in per-item Yjs state; nesting is structural via ComponentNode parentage.",
            prop_schema: prop_schemas::BULLET_LIST_ITEM,
            capabilities: vec![],
            has_yjs_state: true,
            accepts_children: true,
        },
        BuiltinSpec {
            component_type: "NumberedListItem",
            display_name: "Numbered list item",
            description: "Document numbered list item. Text lives in per-item Yjs state; numbering is derived by the renderer.",
            prop_schema: prop_schemas::NUMBERED_LIST_ITEM,
            capabilities: vec![],
            has_yjs_state: true,
            accepts_children: true,
        },
        BuiltinSpec {
            component_type: "ChecklistItem",
            display_name: "Checklist item",
            description: "Document checklist item with checked state in props and text in per-item Yjs state.",
            prop_schema: prop_schemas::CHECKLIST_ITEM,
            capabilities: vec![],
            has_yjs_state: true,
            accepts_children: true,
        },
    ]
}

/// Seed the built-in component type registry. Idempotent — inserts any
/// built-in type row that is not yet present. Safe to call from `init` and
/// from post-upgrade migrations when new sprint-N types ship.
pub(crate) fn seed_builtin_component_types(ctx: &ReducerContext) {
    let publisher_identity = ctx
        .db
        .module_install_meta()
        .id()
        .find(0)
        .map(|m| m.publisher_identity)
        .unwrap_or_else(|| ctx.sender());

    for spec in builtin_specs() {
        let component_type = spec.component_type.to_string();
        if ctx
            .db
            .component_type_definition()
            .component_type()
            .find(component_type.clone())
            .is_some()
        {
            continue;
        }
        ctx.db
            .component_type_definition()
            .insert(ComponentTypeDefinition {
                id: next_component_type_definition_id(ctx),
                component_type,
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

/// Upgrade existing Heading registry rows after the Yjs + section-container
/// unification (0.11.5). `seed_builtin_component_types` only inserts missing
/// types — this patch updates the live Heading definition in place.
pub(crate) fn migrate_heading_yjs_registry_v1(ctx: &ReducerContext) {
    let Some(mut def) = ctx
        .db
        .component_type_definition()
        .component_type()
        .find("Heading".to_string())
    else {
        seed_builtin_component_types(ctx);
        return;
    };

    def.description =
        "Heading with level + Yjs-backed title text. Optional section container when nested blocks are present; collapse via props.collapsed."
            .to_string();
    def.prop_schema = prop_schemas::HEADING.to_string();
    def.has_yjs_state = true;
    def.accepts_children = true;
    ctx.db.component_type_definition().id().update(def);
}

// ============================================================
// Mutation helpers
// ============================================================

/// Load a `ComponentNode` by id and assert it's live (not soft-deleted).
fn require_live_node(ctx: &ReducerContext, component_id: u64) -> Result<ComponentNode, String> {
    let node = ctx
        .db
        .component_node()
        .id()
        .find(component_id)
        .ok_or("ComponentNode not found")?;
    if node.deleted_at.is_some() {
        return Err("ComponentNode is soft-deleted".to_string());
    }
    Ok(node)
}

/// Load a `ComponentNode` by id without filtering on deleted_at. Used by
/// `restore_component` which needs to operate on a deleted row.
fn require_node(ctx: &ReducerContext, component_id: u64) -> Result<ComponentNode, String> {
    ctx.db
        .component_node()
        .id()
        .find(component_id)
        .ok_or("ComponentNode not found".to_string())
}

/// Load the owning `Page` for a surface, assert it isn't deleted, and assert
/// its content_format is `ComponentTree`. Returns the Page row so callers can
/// reuse `updated_at` writes without a second lookup.
fn require_component_tree_page(ctx: &ReducerContext, surface_id: u64) -> Result<Page, String> {
    let page = ctx
        .db
        .page()
        .id()
        .find(surface_id)
        .ok_or("Surface page not found")?;
    if page.deleted_at.is_some() {
        return Err("Surface page is deleted".to_string());
    }
    if !matches!(page.content_format, PageContentFormat::ComponentTree) {
        return Err(
            "Page is not in ComponentTree format — component mutations are rejected".to_string(),
        );
    }
    Ok(page)
}

/// Registry lookup for the component type. Errors if the type isn't
/// registered (invariant #4 — `component_type` is registered).
fn require_type_def(
    ctx: &ReducerContext,
    component_type: &str,
) -> Result<ComponentTypeDefinition, String> {
    ctx.db
        .component_type_definition()
        .component_type()
        .find(component_type.to_string())
        .ok_or_else(|| format!("Unknown component type: {component_type}"))
}

/// Walk `parent_id` upward from `start_id`, returning `true` if `target_id`
/// is reachable. Used by `move_component` to enforce invariant #3 (no cycles).
/// Bounded by the current tree depth; with a tree depth bound of ~50 in
/// practice, this is microseconds.
fn ancestor_chain_contains(
    ctx: &ReducerContext,
    start_id: u64,
    target_id: u64,
) -> Result<bool, String> {
    let mut current = Some(start_id);
    // Safety: hard cap on traversal depth to defend against an externally-
    // injected cycle in case the invariant was ever violated by a previous
    // bug. 10_000 is way above any plausible real tree depth.
    //
    // The two non-cyclic exits are:
    //   - `target_id` found in the chain → `Ok(true)`
    //   - chain walks all the way to a node with `parent_id = None` →
    //     `Ok(false)` (we ran out of ancestors without finding the target)
    // Hitting the loop's natural completion means we walked
    // `max_steps` ancestors without exhausting the chain, which can
    // only happen with a real cycle.
    let max_steps = 10_000usize;
    for _ in 0..max_steps {
        let Some(id) = current else { return Ok(false) };
        if id == target_id {
            return Ok(true);
        }
        let node = ctx
            .db
            .component_node()
            .id()
            .find(id)
            .ok_or("Encountered missing ancestor while walking parent chain")?;
        current = node.parent_id;
    }
    Err("Parent chain exceeds safety cap — refusing to continue".to_string())
}

/// Collect live siblings of a parent within a surface, sorted by `order`.
/// Optionally excludes a node id (used by `move_component` so the moving
/// node isn't in its own destination sibling list).
fn live_siblings_sorted(
    ctx: &ReducerContext,
    surface_id: u64,
    parent_id: u64,
    exclude_id: Option<u64>,
) -> Vec<ComponentNode> {
    let mut sibs: Vec<ComponentNode> = ctx
        .db
        .component_node()
        .iter()
        .filter(|n| {
            n.surface_id == surface_id
                && n.parent_id == Some(parent_id)
                && n.deleted_at.is_none()
                && exclude_id.map_or(true, |ex| n.id != ex)
        })
        .collect();
    sibs.sort_by_key(|n| n.order);
    sibs
}

/// Renumber a sibling list back to clean multiples of 1000 starting at 1000,
/// writing only the rows whose `order` actually changes. Consumes `siblings`
/// (which doesn't include the row the caller is about to insert/move).
/// Returns the order the caller should assign to that row at `insert_index`.
fn renumber_with_gap(
    ctx: &ReducerContext,
    siblings: Vec<ComponentNode>,
    insert_index: usize,
) -> u32 {
    // The slot at `insert_index` is reserved for the caller's row.
    // Siblings before it get orders 1000..(insert_index+1)*1000;
    // siblings at or after it get bumped by one slot.
    for (i, sibling) in siblings.into_iter().enumerate() {
        let target_index = if i < insert_index { i } else { i + 1 };
        let new_order = (target_index as u32 + 1) * 1000;
        if sibling.order != new_order {
            ctx.db.component_node().id().update(ComponentNode {
                order: new_order,
                ..sibling
            });
        }
    }
    (insert_index as u32 + 1) * 1000
}

/// Touch `Page.updated_at` and enqueue page-updated automation. Called by
/// every mutation reducer so the sidebar reflects edits and downstream
/// observers fire.
fn touch_page(ctx: &ReducerContext, page: Page) {
    let page_id = page.id;
    ctx.db.page().id().update(Page {
        updated_at: ctx.timestamp,
        ..page
    });
    enqueue_page_updated(ctx, page_id);
}

// ============================================================
// Reducers — tree mutations
// ============================================================

/// Insert a new `ComponentNode` into a surface's tree.
///
/// - `parent_id` is required (non-`Option`) — root creation is implicit at
///   page-creation time, never via this reducer. Enforces invariant #2.
/// - `after_sibling_id = None` places the node first under the parent.
/// - The new node's `surface_id` is derived from the parent's `surface_id`.
///
/// Rejects if:
/// - the parent doesn't exist or is deleted
/// - the parent's page isn't in `ComponentTree` format
/// - the parent's type doesn't accept children
/// - `component_type` isn't registered
/// - the caller lacks page write access
#[reducer]
pub fn insert_component(
    ctx: &ReducerContext,
    parent_id: u64,
    component_type: String,
    props_json: String,
    after_sibling_id: Option<u64>,
) -> Result<(), String> {
    let parent = require_live_node(ctx, parent_id)?;
    let surface_id = parent.surface_id;
    let page = require_component_tree_page(ctx, surface_id)?;
    require_page_write(ctx, surface_id)?;

    let parent_type = require_type_def(ctx, &parent.component_type)?;
    if !parent_type.accepts_children {
        return Err(format!(
            "Parent component type {:?} does not accept children",
            parent.component_type
        ));
    }
    require_type_def(ctx, &component_type)?;

    let siblings = live_siblings_sorted(ctx, surface_id, parent_id, None);
    let insert_index = match after_sibling_id {
        None => 0,
        Some(sib_id) => siblings
            .iter()
            .position(|n| n.id == sib_id)
            .map(|i| i + 1)
            .ok_or("after_sibling_id is not a sibling under this parent")?,
    };
    let new_order = renumber_with_gap(ctx, siblings, insert_index);

    ctx.db.component_node().insert(ComponentNode {
        id: next_component_node_id(ctx),
        surface_id,
        parent_id: Some(parent_id),
        component_type,
        props: props_json,
        order: new_order,
        created_by: ActorType::Human,
        updated_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
    });

    touch_page(ctx, page);
    Ok(())
}

/// Replace the entire `props` blob on an existing component.
///
/// Partial updates aren't supported — the client merges and ships the full
/// new props object. `component_type` is immutable via this reducer; types
/// change only by replace-and-delete.
#[reducer]
pub fn update_component_props(
    ctx: &ReducerContext,
    component_id: u64,
    props_json: String,
) -> Result<(), String> {
    let node = require_live_node(ctx, component_id)?;
    let page = require_component_tree_page(ctx, node.surface_id)?;
    require_page_write(ctx, node.surface_id)?;

    ctx.db.component_node().id().update(ComponentNode {
        props: props_json,
        updated_by: ActorType::Human,
        updated_at: ctx.timestamp,
        ..node
    });

    touch_page(ctx, page);
    Ok(())
}

/// Reparent and/or reorder a component within its own surface.
///
/// - `new_parent_id` must reference a live node in the same surface.
/// - Refuses to move the surface's root (a node with `parent_id = None`).
/// - Refuses moves that would form a cycle (walks `parent_id` from
///   `new_parent_id` upward; rejects if `component_id` appears).
/// - Refuses moves whose new parent's type doesn't accept children.
#[reducer]
pub fn move_component(
    ctx: &ReducerContext,
    component_id: u64,
    new_parent_id: u64,
    after_sibling_id: Option<u64>,
) -> Result<(), String> {
    if component_id == new_parent_id {
        return Err("A component cannot be its own parent".to_string());
    }

    let node = require_live_node(ctx, component_id)?;
    if node.parent_id.is_none() {
        return Err("Root component cannot be moved".to_string());
    }

    let new_parent = require_live_node(ctx, new_parent_id)?;
    if new_parent.surface_id != node.surface_id {
        return Err("Cross-surface moves are not allowed".to_string());
    }

    let page = require_component_tree_page(ctx, node.surface_id)?;
    require_page_write(ctx, node.surface_id)?;

    let new_parent_type = require_type_def(ctx, &new_parent.component_type)?;
    if !new_parent_type.accepts_children {
        return Err(format!(
            "Target parent component type {:?} does not accept children",
            new_parent.component_type
        ));
    }

    if ancestor_chain_contains(ctx, new_parent_id, component_id)? {
        return Err(
            "Move rejected: would create a cycle (new_parent is a descendant of the moving node)"
                .to_string(),
        );
    }

    let siblings = live_siblings_sorted(ctx, node.surface_id, new_parent_id, Some(component_id));
    let insert_index = match after_sibling_id {
        None => 0,
        Some(sib_id) => siblings
            .iter()
            .position(|n| n.id == sib_id)
            .map(|i| i + 1)
            .ok_or("after_sibling_id is not a sibling under the new parent")?,
    };
    let new_order = renumber_with_gap(ctx, siblings, insert_index);

    ctx.db.component_node().id().update(ComponentNode {
        parent_id: Some(new_parent_id),
        order: new_order,
        updated_by: ActorType::Human,
        updated_at: ctx.timestamp,
        ..node
    });

    touch_page(ctx, page);
    Ok(())
}

/// Soft-delete a component. Sets `deleted_at` on the target node only; does
/// not cascade. The renderer hides any node whose ancestor chain contains a
/// deleted node, so orphaned subtrees stop rendering even though their rows
/// remain in the table (available for `restore_component` or for an
/// "unwrap-and-keep-children" client UX).
///
/// Refuses to delete the surface's root node — once the root is gone the
/// page has no rendered content, which should be done via page deletion,
/// not component deletion.
#[reducer]
pub fn delete_component(ctx: &ReducerContext, component_id: u64) -> Result<(), String> {
    let node = require_live_node(ctx, component_id)?;
    if node.parent_id.is_none() {
        return Err("Root component cannot be deleted — delete the page instead".to_string());
    }
    let page = require_component_tree_page(ctx, node.surface_id)?;
    require_page_write(ctx, node.surface_id)?;

    ctx.db.component_node().id().update(ComponentNode {
        deleted_at: Some(ctx.timestamp),
        updated_by: ActorType::Human,
        updated_at: ctx.timestamp,
        ..node
    });

    touch_page(ctx, page);
    Ok(())
}

/// Undo a `delete_component`. Refuses if any ancestor on the parent chain is
/// currently deleted — restoring an orphan whose parent is gone produces an
/// invisible node, which we surface as an error rather than silently allow.
///
/// To restore a node under a deleted ancestor, restore the ancestors first
/// (top-down) or move the node to a live parent before restoring.
#[reducer]
pub fn restore_component(ctx: &ReducerContext, component_id: u64) -> Result<(), String> {
    let node = require_node(ctx, component_id)?;
    if node.deleted_at.is_none() {
        return Err("ComponentNode is not deleted".to_string());
    }
    let page = require_component_tree_page(ctx, node.surface_id)?;
    require_page_write(ctx, node.surface_id)?;

    let mut current = node.parent_id;
    let max_steps = 10_000usize;
    for _ in 0..max_steps {
        let Some(id) = current else { break };
        let ancestor = ctx
            .db
            .component_node()
            .id()
            .find(id)
            .ok_or("Missing ancestor on parent chain")?;
        if ancestor.deleted_at.is_some() {
            return Err(
                "Cannot restore: an ancestor is currently deleted. Restore ancestors first \
                 (top-down), or move this node under a live parent before restoring."
                    .to_string(),
            );
        }
        current = ancestor.parent_id;
    }

    ctx.db.component_node().id().update(ComponentNode {
        deleted_at: None,
        updated_by: ActorType::Human,
        updated_at: ctx.timestamp,
        ..node
    });

    touch_page(ctx, page);
    Ok(())
}

// ============================================================
// Reducers — BlockNote → ComponentTree migration
// ============================================================

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlockNoteMigrationPayload {
    v: String,
    components: Vec<BlockNoteMigrationComponent>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlockNoteMigrationComponent {
    source_block_id: String,
    parent_source_block_id: Option<String>,
    component_type: String,
    props_json: String,
    yjs_data_b64: Option<String>,
    sibling_index: u32,
}

/// Atomically convert a `BlockNote`-format page to `ComponentTree`.
///
/// The client supplies a payload from `@eclosion-tech/pulp`'s
/// `buildMigrationPayload` (version `blocknote_migration_v1`). The reducer:
///
/// 1. Validates the page is still `BlockNote` and has no live component rows.
/// 2. Inserts a root `Container` plus the converted block tree.
/// 3. Upserts `ComponentYjsState` for Yjs-backed nodes when `yjs_data_b64` is set.
/// 4. Sets `Page.content_format = ComponentTree`.
///
/// Legacy `PageContent` and `PageYjsState` rows are retained as an audit trail
/// until global BlockNote retirement.
#[reducer]
pub fn migrate_page_to_component_tree(
    ctx: &ReducerContext,
    page_id: u64,
    payload_json: String,
) -> Result<(), String> {
    use base64::Engine;
    use std::collections::HashMap;

    let page = require_blocknote_page(ctx, page_id)?;
    require_page_write(ctx, page_id)?;

    if ctx.db.component_node().iter().any(|n| {
        n.surface_id == page_id && n.deleted_at.is_none()
    }) {
        return Err(
            "Page already has ComponentNode rows — refusing to migrate twice".to_string(),
        );
    }

    let payload: BlockNoteMigrationPayload = serde_json::from_str(&payload_json)
        .map_err(|e| format!("migration payload json: {e}"))?;
    if payload.v != "blocknote_migration_v1" {
        return Err(format!(
            "Unknown migration payload version: {}",
            payload.v
        ));
    }

    let root_id = next_component_node_id(ctx);
    ctx.db.component_node().insert(ComponentNode {
        id: root_id,
        surface_id: page_id,
        parent_id: None,
        component_type: "Container".to_string(),
        props: r#"{"layout":"stack"}"#.to_string(),
        order: 1000,
        created_by: ActorType::Human,
        updated_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
    });

    let mut id_map: HashMap<String, u64> = HashMap::new();

    if payload.components.is_empty() {
        let empty_id = next_component_node_id(ctx);
        ctx.db.component_node().insert(ComponentNode {
            id: empty_id,
            surface_id: page_id,
            parent_id: Some(root_id),
            component_type: "RichText".to_string(),
            props: "{}".to_string(),
            order: 1000,
            created_by: ActorType::Human,
            updated_by: ActorType::Human,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
            deleted_at: None,
        });
    } else {
        for row in &payload.components {
            require_type_def(ctx, &row.component_type)?;

            let parent_id = match row.parent_source_block_id.as_deref() {
                None | Some("") => root_id,
                Some(key) => *id_map.get(key).ok_or_else(|| {
                    format!(
                        "Component {} references unknown parent {}",
                        row.source_block_id, key
                    )
                })?,
            };

            let parent_type = require_type_def(
                ctx,
                &ctx
                    .db
                    .component_node()
                    .id()
                    .find(parent_id)
                    .ok_or("Migration parent node missing")?
                    .component_type,
            )?;
            if !parent_type.accepts_children {
                return Err(format!(
                    "Parent type {:?} does not accept children (child {})",
                    parent_type.component_type, row.source_block_id
                ));
            }

            let new_id = next_component_node_id(ctx);
            id_map.insert(row.source_block_id.clone(), new_id);
            let order = (row.sibling_index + 1) * 1000;

            ctx.db.component_node().insert(ComponentNode {
                id: new_id,
                surface_id: page_id,
                parent_id: Some(parent_id),
                component_type: row.component_type.clone(),
                props: row.props_json.clone(),
                order,
                created_by: ActorType::Human,
                updated_by: ActorType::Human,
                created_at: ctx.timestamp,
                updated_at: ctx.timestamp,
                deleted_at: None,
            });

            if let Some(b64) = row.yjs_data_b64.as_deref() {
                if b64.trim().is_empty() {
                    continue;
                }
                let type_def = require_type_def(ctx, &row.component_type)?;
                if !type_def.has_yjs_state {
                    return Err(format!(
                        "Component {} sent yjs_data_b64 but type {:?} is not Yjs-backed",
                        row.source_block_id, row.component_type
                    ));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64.trim())
                    .map_err(|e| {
                        format!(
                            "yjs_data_b64 decode for {}: {e}",
                            row.source_block_id
                        )
                    })?;
                ctx.db.component_yjs_state().insert(ComponentYjsState {
                    component_node_id: new_id,
                    data: bytes,
                    updated_at: ctx.timestamp,
                });
            }
        }
    }

    ctx.db.page().id().update(Page {
        content_format: PageContentFormat::ComponentTree,
        updated_at: ctx.timestamp,
        ..page
    });

    enqueue_page_updated(ctx, page_id);
    Ok(())
}

fn require_blocknote_page(ctx: &ReducerContext, page_id: u64) -> Result<Page, String> {
    let page = ctx
        .db
        .page()
        .id()
        .find(page_id)
        .ok_or("Page not found")?;
    if page.deleted_at.is_some() {
        return Err("Page is deleted".to_string());
    }
    if !matches!(page.content_format, PageContentFormat::BlockNote) {
        return Err("Page is not BlockNote format — already migrated or wrong type".to_string());
    }
    Ok(page)
}

// ============================================================
// Reducers — per-component Yjs state
// ============================================================

/// Upsert the Yjs blob for a Yjs-backed component (typically `RichText`).
///
/// Refuses to write for component types whose registry entry has
/// `has_yjs_state = false` (integrity invariant #6) — non-Yjs components
/// must never grow a `ComponentYjsState` row.
///
/// The client writes the whole encoded state on blur / unmount / a ~30s
/// tick, same cadence as the legacy `save_yjs_state` for BlockNote pages.
#[reducer]
pub fn save_component_yjs_state(
    ctx: &ReducerContext,
    component_id: u64,
    data: Vec<u8>,
) -> Result<(), String> {
    let node = require_live_node(ctx, component_id)?;
    let page = require_component_tree_page(ctx, node.surface_id)?;
    require_page_write(ctx, node.surface_id)?;

    let type_def = require_type_def(ctx, &node.component_type)?;
    if !type_def.has_yjs_state {
        return Err(format!(
            "Component type {:?} does not support Yjs state — refusing to upsert ComponentYjsState",
            node.component_type
        ));
    }

    if let Some(existing) = ctx
        .db
        .component_yjs_state()
        .component_node_id()
        .find(component_id)
    {
        ctx.db
            .component_yjs_state()
            .component_node_id()
            .update(ComponentYjsState {
                data,
                updated_at: ctx.timestamp,
                ..existing
            });
    } else {
        ctx.db.component_yjs_state().insert(ComponentYjsState {
            component_node_id: component_id,
            data,
            updated_at: ctx.timestamp,
        });
    }

    touch_page(ctx, page);
    Ok(())
}

// ============================================================
// Reducers — batched document writes
// ============================================================

/// One block of a batched page-body write. Carried by [`replace_page_doc`]
/// and [`append_page_doc`] so an entire document lands in a single reducer
/// call — one transaction, one subrequest from HTTP callers — instead of an
/// `insert_component` + `save_component_yjs_state` round-trip per block.
#[derive(SpacetimeType, Clone, Debug)]
pub struct DocBlockInput {
    /// Looked up in [`ComponentTypeDefinition`]; unknown types reject the
    /// whole batch.
    pub component_type: String,
    /// JSON-encoded props (`{}` for none) — same contract as
    /// `insert_component`.
    pub props_json: String,
    /// Encoded Yjs state (`Y.encodeStateAsUpdate` output) for Yjs-backed
    /// types. Must be `None` for types with `has_yjs_state = false`.
    pub yjs_state: Option<Vec<u8>>,
}

/// Defensive ceiling on blocks per batched write. Far above any real
/// document write; exists so a malformed call can't insert unbounded rows.
const MAX_DOC_BLOCKS_PER_CALL: usize = 2_000;

/// Replace a page's document body in one transaction: soft-delete the live
/// children of the surface root, then insert `blocks` in order as new
/// children (with their Yjs state, where given). Any validation failure
/// rolls the whole write back — no half-written pages.
#[reducer]
pub fn replace_page_doc(
    ctx: &ReducerContext,
    page_id: u64,
    blocks: Vec<DocBlockInput>,
) -> Result<(), String> {
    write_page_doc(ctx, page_id, blocks, true)
}

/// Append `blocks` after the last live child of the surface root, in one
/// transaction. Existing content is untouched — the safe primitive for
/// "add to this page" flows (e.g. memory appends).
#[reducer]
pub fn append_page_doc(
    ctx: &ReducerContext,
    page_id: u64,
    blocks: Vec<DocBlockInput>,
) -> Result<(), String> {
    write_page_doc(ctx, page_id, blocks, false)
}

fn write_page_doc(
    ctx: &ReducerContext,
    page_id: u64,
    blocks: Vec<DocBlockInput>,
    replace: bool,
) -> Result<(), String> {
    if blocks.len() > MAX_DOC_BLOCKS_PER_CALL {
        return Err(format!(
            "Too many blocks in one call ({} > {MAX_DOC_BLOCKS_PER_CALL})",
            blocks.len()
        ));
    }
    let page = require_component_tree_page(ctx, page_id)?;
    require_page_write(ctx, page_id)?;

    let root = ctx
        .db
        .component_node()
        .surface_id()
        .filter(page_id)
        .find(|n| n.parent_id.is_none() && n.deleted_at.is_none())
        .ok_or("No root component node for this page — cannot author content")?;
    let root_type = require_type_def(ctx, &root.component_type)?;
    if !root_type.accepts_children {
        return Err(format!(
            "Root component type {:?} does not accept children",
            root.component_type
        ));
    }

    // Validate the whole batch before touching any row, so rejections carry
    // a clean per-block error (the transaction would roll back either way).
    for (i, block) in blocks.iter().enumerate() {
        let type_def = require_type_def(ctx, &block.component_type)?;
        if block.yjs_state.is_some() && !type_def.has_yjs_state {
            return Err(format!(
                "Block {i}: component type {:?} does not support Yjs state",
                block.component_type
            ));
        }
    }

    let existing = live_siblings_sorted(ctx, page_id, root.id, None);
    let mut next_order = if replace {
        for child in existing {
            ctx.db.component_node().id().update(ComponentNode {
                deleted_at: Some(ctx.timestamp),
                updated_by: ActorType::Human,
                updated_at: ctx.timestamp,
                ..child
            });
        }
        1000u32
    } else {
        existing.last().map_or(1000, |n| n.order.saturating_add(1000))
    };

    for block in blocks {
        let id = next_component_node_id(ctx);
        ctx.db.component_node().insert(ComponentNode {
            id,
            surface_id: page_id,
            parent_id: Some(root.id),
            component_type: block.component_type,
            props: block.props_json,
            order: next_order,
            created_by: ActorType::Human,
            updated_by: ActorType::Human,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
            deleted_at: None,
        });
        next_order = next_order.saturating_add(1000);

        if let Some(data) = block.yjs_state {
            ctx.db.component_yjs_state().insert(ComponentYjsState {
                component_node_id: id,
                data,
                updated_at: ctx.timestamp,
            });
        }
    }

    touch_page(ctx, page);
    Ok(())
}

// ============================================================
// Reducers — registry
// ============================================================

/// Register a new (non-builtin) `ComponentTypeDefinition`. Used by tier-5
/// extension packs that bundle their own component types. The registering
/// `Identity` (the reducer caller) is recorded in `registered_by` so
/// subsequent `update_component_type` calls can enforce ownership.
///
/// - `is_builtin` is forced to `false` regardless of caller. Built-in types
///   are seeded once at `init` via `seed_builtin_component_types` and are
///   immutable.
/// - `component_type` must be globally unique. Returns an error if a type
///   with this string already exists.
/// - `prop_schema_json` is stored opaquely — server-side schema validation
///   is post-v1 (see ADR § Prop-schema validation).
#[reducer]
pub fn register_component_type(
    ctx: &ReducerContext,
    component_type: String,
    display_name: String,
    description: String,
    prop_schema_json: String,
    capabilities: Vec<ComponentCapability>,
    has_yjs_state: bool,
    accepts_children: bool,
) -> Result<(), String> {
    if component_type.trim().is_empty() {
        return Err("component_type cannot be empty".to_string());
    }
    if ctx
        .db
        .component_type_definition()
        .component_type()
        .find(component_type.clone())
        .is_some()
    {
        return Err(format!(
            "Component type {component_type:?} is already registered"
        ));
    }

    ctx.db
        .component_type_definition()
        .insert(ComponentTypeDefinition {
            id: next_component_type_definition_id(ctx),
            component_type,
            display_name,
            description,
            prop_schema: prop_schema_json,
            capabilities,
            has_yjs_state,
            accepts_children,
            is_builtin: false,
            registered_by: ctx.sender(),
            created_at: ctx.timestamp,
        });
    Ok(())
}

/// Update a previously-registered (non-builtin) `ComponentTypeDefinition`.
///
/// - Refuses to modify `is_builtin = true` rows.
/// - Caller must be either the original `registered_by` identity or an
///   admin (`User.is_admin && User.is_authenticated`).
/// - `component_type`, `has_yjs_state`, `accepts_children`, and the
///   ownership/builtin flags are immutable through this reducer — changing
///   them would require migrating every `ComponentNode` row that points
///   to this type, which is out of scope for a metadata update. Drop and
///   re-register if you really need a different shape.
#[reducer]
pub fn update_component_type(
    ctx: &ReducerContext,
    type_id: u64,
    display_name: Option<String>,
    description: Option<String>,
    prop_schema_json: Option<String>,
    capabilities: Option<Vec<ComponentCapability>>,
) -> Result<(), String> {
    let existing = ctx
        .db
        .component_type_definition()
        .id()
        .find(type_id)
        .ok_or("ComponentTypeDefinition not found")?;

    if existing.is_builtin {
        return Err("Cannot modify a built-in component type".to_string());
    }

    let sender = ctx.sender();
    let is_admin = ctx
        .db
        .user()
        .identity()
        .find(sender)
        .map(|u| u.is_admin && u.is_authenticated)
        .unwrap_or(false);
    if existing.registered_by != sender && !is_admin {
        return Err(
            "Only the registering identity or a workspace admin may update this component type"
                .to_string(),
        );
    }

    ctx.db
        .component_type_definition()
        .id()
        .update(ComponentTypeDefinition {
            display_name: display_name.unwrap_or_else(|| existing.display_name.clone()),
            description: description.unwrap_or_else(|| existing.description.clone()),
            prop_schema: prop_schema_json.unwrap_or_else(|| existing.prop_schema.clone()),
            capabilities: capabilities.unwrap_or_else(|| existing.capabilities.clone()),
            ..existing
        });
    Ok(())
}

// ============================================================
// Purge / snapshot helpers (consumed by pages/mod.rs + snapshots.rs)
// ============================================================

/// Hard-delete every `ComponentNode` and `ComponentYjsState` row associated
/// with a surface. Called by `purge_page_inner` after a page exits its
/// 30-day soft-delete grace window. Idempotent — safe to call on
/// `BlockNote`-format pages too (no rows match; no-op).
pub(crate) fn purge_component_tree(ctx: &ReducerContext, page_id: u64) {
    let node_ids: Vec<u64> = ctx
        .db
        .component_node()
        .iter()
        .filter(|n| n.surface_id == page_id)
        .map(|n| n.id)
        .collect();
    for nid in &node_ids {
        ctx.db
            .component_yjs_state()
            .component_node_id()
            .delete(*nid);
        ctx.db.component_node().id().delete(*nid);
    }
}

/// Serialize the live `ComponentNode` tree for a surface to a JSON blob
/// suitable for storage in `PageSnapshot.content`. Includes per-`RichText`
/// Yjs bytes (base64) so the snapshot is round-trip restorable.
///
/// Nodes are emitted in BFS order from the root so `restore_component_tree`
/// can walk linearly: every parent appears before any of its children, so
/// the `parent_id` remap is always already populated by the time it's
/// needed. Soft-deleted nodes are excluded — restoring a snapshot reflects
/// "the page as it was when live."
pub(crate) fn serialize_component_tree(
    ctx: &ReducerContext,
    page_id: u64,
) -> Result<String, String> {
    use base64::Engine;
    use std::collections::{HashMap, VecDeque};

    let live_nodes: Vec<ComponentNode> = ctx
        .db
        .component_node()
        .iter()
        .filter(|n| n.surface_id == page_id && n.deleted_at.is_none())
        .collect();

    // Index by id and group by parent so BFS is cheap.
    let mut by_id: HashMap<u64, ComponentNode> = HashMap::with_capacity(live_nodes.len());
    let mut children_of: HashMap<Option<u64>, Vec<u64>> = HashMap::new();
    let mut node_order: HashMap<u64, u32> = HashMap::new();
    let mut root_id: Option<u64> = None;
    for n in live_nodes {
        if n.parent_id.is_none() {
            root_id = Some(n.id);
        }
        node_order.insert(n.id, n.order);
        children_of.entry(n.parent_id).or_default().push(n.id);
        by_id.insert(n.id, n);
    }
    for ids in children_of.values_mut() {
        ids.sort_by_key(|id| node_order.get(id).copied().unwrap_or(0));
    }

    let mut ordered: Vec<ComponentNode> = Vec::with_capacity(by_id.len());
    if let Some(rid) = root_id {
        let mut queue: VecDeque<u64> = VecDeque::new();
        queue.push_back(rid);
        while let Some(id) = queue.pop_front() {
            if let Some(n) = by_id.remove(&id) {
                let children = children_of.remove(&Some(id)).unwrap_or_default();
                ordered.push(n);
                for cid in children {
                    queue.push_back(cid);
                }
            }
        }
    }

    let nodes_value: Vec<serde_json::Value> = ordered
        .into_iter()
        .map(|n| {
            let yjs_b64 = ctx
                .db
                .component_yjs_state()
                .component_node_id()
                .find(n.id)
                .map(|s| base64::engine::general_purpose::STANDARD.encode(&s.data));
            serde_json::json!({
                "id": n.id,
                "parent_id": n.parent_id,
                "component_type": n.component_type,
                "props": n.props,
                "order": n.order,
                "yjs_b64": yjs_b64,
            })
        })
        .collect();

    let snapshot = serde_json::json!({
        "v": "component_tree_v1",
        "root_id": root_id,
        "nodes": nodes_value,
    });
    Ok(snapshot.to_string())
}

/// Restore a surface's component tree from a JSON blob produced by
/// `serialize_component_tree`. Wipes the surface's current
/// `ComponentNode` + `ComponentYjsState` rows, then re-creates them from
/// the snapshot, allocating fresh IDs and remapping `parent_id` references.
///
/// Errors if the JSON is missing fields, has an unknown format version,
/// references an unknown `component_type`, or has any other shape problem.
/// Atomicity: SpacetimeDB reducers commit-or-rollback as a unit, so a
/// partial restore is impossible — any error rolls back the wipe too.
pub(crate) fn restore_component_tree(
    ctx: &ReducerContext,
    page_id: u64,
    snapshot_json: &str,
) -> Result<(), String> {
    use base64::Engine;

    let parsed: serde_json::Value =
        serde_json::from_str(snapshot_json).map_err(|e| format!("snapshot json: {e}"))?;
    let obj = parsed.as_object().ok_or("snapshot root is not an object")?;
    let version = obj
        .get("v")
        .and_then(|v| v.as_str())
        .ok_or("snapshot missing 'v' field")?;
    if version != "component_tree_v1" {
        return Err(format!("Unknown snapshot format version: {version}"));
    }
    let nodes_arr = obj
        .get("nodes")
        .and_then(|v| v.as_array())
        .ok_or("snapshot missing 'nodes' array")?;

    purge_component_tree(ctx, page_id);

    let mut id_map: std::collections::HashMap<u64, u64> =
        std::collections::HashMap::with_capacity(nodes_arr.len());

    for n in nodes_arr {
        let m = n.as_object().ok_or("snapshot node is not an object")?;
        let snap_id = m.get("id").and_then(|v| v.as_u64()).ok_or("node.id")?;
        let snap_parent_id = m.get("parent_id").and_then(|v| {
            if v.is_null() {
                Some(None)
            } else {
                v.as_u64().map(Some)
            }
        });
        let snap_parent_id = snap_parent_id.ok_or("node.parent_id (null or u64)")?;
        let component_type = m
            .get("component_type")
            .and_then(|v| v.as_str())
            .ok_or("node.component_type")?
            .to_string();
        let props = m
            .get("props")
            .and_then(|v| v.as_str())
            .ok_or("node.props")?
            .to_string();
        let order = m
            .get("order")
            .and_then(|v| v.as_u64())
            .ok_or("node.order")? as u32;
        let yjs_b64 = m.get("yjs_b64").and_then(|v| v.as_str()).map(String::from);

        // Verify type is registered.
        require_type_def(ctx, &component_type)?;

        // Map parent_id (None → None for root; Some(snap_p) must already be in id_map).
        let new_parent_id =
            match snap_parent_id {
                None => None,
                Some(p) => Some(*id_map.get(&p).ok_or_else(|| {
                    format!("snapshot node {snap_id} references unknown parent {p}")
                })?),
            };

        let new_id = next_component_node_id(ctx);
        id_map.insert(snap_id, new_id);

        ctx.db.component_node().insert(ComponentNode {
            id: new_id,
            surface_id: page_id,
            parent_id: new_parent_id,
            component_type,
            props,
            order,
            created_by: ActorType::Human,
            updated_by: ActorType::Human,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
            deleted_at: None,
        });

        if let Some(b64) = yjs_b64 {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|e| format!("yjs_b64 decode for snapshot node {snap_id}: {e}"))?;
            ctx.db.component_yjs_state().insert(ComponentYjsState {
                component_node_id: new_id,
                data: bytes,
                updated_at: ctx.timestamp,
            });
        }
    }
    Ok(())
}
