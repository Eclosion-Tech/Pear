//! Workspace repository. Private storage is exposed only through member-scoped views.
use crate::access_control::helpers::{
    require_creator_or_admin, require_page_write, require_workspace_principal,
};
use crate::ai::ai_user_profile__view;
use crate::auth::user__view;
use crate::module_install::module_install_meta__view;
use crate::pages::components::{
    component_node,
    trellis_panel::{interface_state as state, repository_state as export, COMPONENT_TYPE},
};
use crate::pages::page;
use serde_json::{json, Value};
use spacetimedb::{reducer, table, view, Identity, ReducerContext, Table, Timestamp, ViewContext};

#[table(accessor = component_template_family, private)]
pub struct ComponentTemplateFamily {
    #[primary_key]
    pub template_id: String,
    #[index(btree)]
    pub scope: u8,
    pub name: String,
    pub description: String,
    pub tags_json: String,
    pub owner: Identity,
    pub latest_version: String,
    pub archived: bool,
    pub revision: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
#[table(accessor = component_template_version, private)]
pub struct ComponentTemplateVersion {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub scope: u8,
    #[index(btree)]
    pub template_id: String,
    pub version: String,
    pub package_json: String,
    pub content_hash: String,
    pub published_by: Identity,
    pub published_at: Timestamp,
}
#[table(accessor = component_repository_receipt, private)]
pub struct ComponentRepositoryReceipt {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub principal: Identity,
    pub request_id: String,
    pub fingerprint: String,
    pub template_id: String,
    pub operation: String,
    pub result_revision: u64,
    pub created_at: Timestamp,
}
fn member(ctx: &ViewContext) -> bool {
    let identity = ctx.sender();
    ctx.db
        .user()
        .identity()
        .find(identity)
        .is_some_and(|u| u.is_authenticated)
        || ctx.db.ai_user_profile().identity().find(identity).is_some()
        || ctx
            .db
            .module_install_meta()
            .id()
            .find(0)
            .is_some_and(|m| m.publisher_identity == identity)
}
#[view(accessor = workspace_component_template, public)]
pub fn workspace_component_template(ctx: &ViewContext) -> Vec<ComponentTemplateFamily> {
    if !member(ctx) {
        return vec![];
    }
    ctx.db
        .component_template_family()
        .scope()
        .filter(0u8)
        .collect()
}
#[view(accessor = workspace_component_template_version, public)]
pub fn workspace_component_template_version(ctx: &ViewContext) -> Vec<ComponentTemplateVersion> {
    if !member(ctx) {
        return vec![];
    }
    // Range iteration is deliberate: ViewContext only exposes indexed reads.
    ctx.db
        .component_template_version()
        .scope()
        .filter(0u8)
        .collect()
}
// 2.0.3 caches view function pointers in dependency read sets across upgrades.
// Register new repository views after existing views so those pointers stay
// stable. Keep the public SQL name while appending this internal accessor.
#[view(accessor = workspace_component_repository_receipt, name = "my_component_repository_receipt", public)]
pub fn my_component_repository_receipt(ctx: &ViewContext) -> Vec<ComponentRepositoryReceipt> {
    if !member(ctx) {
        return vec![];
    }
    ctx.db
        .component_repository_receipt()
        .principal()
        .filter(ctx.sender())
        .collect()
}
pub(crate) fn registry(
    ctx: &ReducerContext,
    template_id: &str,
    version: &str,
) -> Result<Value, String> {
    let mut registry = state::registry();
    if template_id.starts_with("workspace:") {
        let row = ctx
            .db
            .component_template_version()
            .key()
            .find(format!("{template_id}@{version}"))
            .ok_or("TEMPLATE_NOT_FOUND: Exact workspace component version unavailable")?;
        let package = state::parse_json(&row.package_json)?;
        registry["definitions"]
            .as_array_mut()
            .unwrap()
            .push(package["definition"].clone());
    }
    Ok(registry)
}
pub(crate) fn registry_for_props(ctx: &ReducerContext, props: &str) -> Result<Value, String> {
    let saved = state::parse_json(props)?;
    registry(
        ctx,
        state::text(&saved["document"]["template"]["id"])?,
        state::text(&saved["document"]["template"]["version"])?,
    )
}
pub(crate) fn registry_for_create(ctx: &ReducerContext, raw: &str) -> Result<Value, String> {
    let descriptor = state::parse_json(raw)?;
    let template_id = state::text(&descriptor["templateId"])?;
    if template_id.starts_with("workspace:")
        && ctx
            .db
            .component_template_family()
            .template_id()
            .find(template_id.to_string())
            .is_some_and(|f| f.archived)
    {
        return Err("TEMPLATE_ARCHIVED: This component template is archived; existing instances remain available".into());
    }
    registry(
        ctx,
        template_id,
        state::text(&descriptor["templateVersion"])?,
    )
}
fn replay(ctx: &ReducerContext, request_id: &str, fingerprint: &str) -> Result<bool, String> {
    state::id(&json!(request_id))?;
    let key = format!("{}:{request_id}", ctx.sender().to_hex());
    match ctx.db.component_repository_receipt().key().find(key) {
        Some(receipt) if receipt.fingerprint == fingerprint => Ok(true),
        Some(_) => Err("REQUEST_REUSED: Repository request has different arguments".into()),
        None => Ok(false),
    }
}
fn receipt(
    ctx: &ReducerContext,
    request_id: String,
    fingerprint: String,
    template_id: String,
    operation: &str,
    revision: u64,
) {
    let mut rows: Vec<_> = ctx
        .db
        .component_repository_receipt()
        .principal()
        .filter(ctx.sender())
        .collect();
    rows.sort_by_key(|r| r.created_at);
    let remove = rows.len().saturating_sub(127);
    for old in rows.into_iter().take(remove) {
        ctx.db.component_repository_receipt().key().delete(old.key);
    }
    ctx.db
        .component_repository_receipt()
        .insert(ComponentRepositoryReceipt {
            key: format!("{}:{request_id}", ctx.sender().to_hex()),
            principal: ctx.sender(),
            request_id,
            fingerprint,
            template_id,
            operation: operation.into(),
            result_revision: revision,
            created_at: ctx.timestamp,
        });
}
#[reducer]
pub fn publish_component_template(
    ctx: &ReducerContext,
    source_component_id: String,
    source_revision: u64,
    options_json: String,
    expected_hash: String,
    audience: String,
    request_id: String,
) -> Result<(), String> {
    require_workspace_principal(ctx)?;
    crate::import::pear_v2::require_no_snapshot_import(ctx).map_err(|_| {
        "IMPORT_IN_PROGRESS: Finish or abort the workspace import before publishing components"
    })?;
    if audience != "workspace" {
        return Err("INVALID_TEMPLATE: Explicit workspace publication audience is required".into());
    }
    let node = ctx
        .db
        .component_node()
        .id()
        .find(super::pages::components::trellis_panel::state::id(
            &source_component_id,
        )?)
        .filter(|n| n.deleted_at.is_none() && n.component_type == COMPONENT_TYPE)
        .ok_or("PANEL_UNAVAILABLE: Source component unavailable")?;
    ctx.db
        .page()
        .id()
        .find(node.surface_id)
        .filter(|p| p.deleted_at.is_none())
        .ok_or("PANEL_UNAVAILABLE: Source page unavailable")?;
    require_page_write(ctx, node.surface_id)?;
    let options = export::options(&options_json)?;
    let template_id = format!("workspace:{}", options["slug"].as_str().unwrap());
    let family = ctx
        .db
        .component_template_family()
        .template_id()
        .find(template_id.clone());
    if let Some(existing) = &family {
        require_creator_or_admin(ctx, existing.owner, "publish a version of this component")?;
    }
    let fingerprint = state::hash(&format!("trellis.publish.v1\n{source_component_id}\n{source_revision}\n{options_json}\n{expected_hash}\n{audience}"));
    if replay(ctx, &request_id, &fingerprint)? {
        return Ok(());
    }
    let source_registry = registry_for_props(ctx, &node.props)?;
    let saved = state::parse_with_registry(&node.props, &source_registry)?;
    if saved["document"]["documentId"]
        != format!("pear-page:{}:component:{}", node.surface_id, node.id)
        || saved["document"]["template"]["instanceId"] != format!("pear-component:{}", node.id)
    {
        return Err("INVALID_INTERFACE: Source interface belongs to another component".into());
    }
    if state::rev(&saved["document"]["revision"])? != source_revision {
        return Err("STALE_REVISION: Source interface changed; preview the template again".into());
    }
    let package = export::prepare(&node.props, &source_registry, &options_json)?;
    let bytes = export::canonical(&package)?;
    let hash = state::hash(&bytes);
    if expected_hash != hash {
        return Err(
            "PREVIEW_CHANGED: The template preview changed; inspect it before publishing".into(),
        );
    }
    let version = state::text(&options["version"])?;
    let key = format!("{template_id}@{version}");
    if ctx
        .db
        .component_template_version()
        .key()
        .find(key.clone())
        .is_some()
    {
        return Err("IMMUTABLE_VERSION: A published version cannot be overwritten".into());
    }
    if ctx.db.component_template_version().iter().count() >= 256 {
        return Err("LIMIT: Workspace component version limit reached".into());
    }
    if let Some(existing) = &family {
        if existing.archived {
            return Err("TEMPLATE_ARCHIVED: Restore the template family before publishing".into());
        }
        if export::version(version)? <= export::version(&existing.latest_version)? {
            return Err(
                "INVALID_TEMPLATE: A new version must be greater than the latest published version"
                    .into(),
            );
        }
    } else if ctx.db.component_template_family().iter().count() >= 64 {
        return Err("LIMIT: Workspace component template limit reached".into());
    }
    let revision = match &family {
        Some(f) => f
            .revision
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or("LIMIT: Revision exhausted")?,
        None => 0,
    };
    let row = ComponentTemplateFamily {
        template_id: template_id.clone(),
        scope: 0,
        name: state::text(&options["name"])?.to_string(),
        description: state::text(&options["description"])?.to_string(),
        tags_json: options["tags"].to_string(),
        owner: family.as_ref().map(|f| f.owner).unwrap_or(ctx.sender()),
        latest_version: version.into(),
        archived: false,
        revision,
        created_at: family
            .as_ref()
            .map(|f| f.created_at)
            .unwrap_or(ctx.timestamp),
        updated_at: ctx.timestamp,
    };
    let revision = row.revision;
    if family.is_some() {
        ctx.db.component_template_family().template_id().update(row);
    } else {
        ctx.db.component_template_family().insert(row);
    }
    ctx.db
        .component_template_version()
        .insert(ComponentTemplateVersion {
            key,
            scope: 0,
            template_id: template_id.clone(),
            version: version.into(),
            package_json: bytes,
            content_hash: hash,
            published_by: ctx.sender(),
            published_at: ctx.timestamp,
        });
    receipt(
        ctx,
        request_id,
        fingerprint,
        template_id,
        "publish",
        revision,
    );
    Ok(())
}
#[reducer]
pub fn archive_component_template(
    ctx: &ReducerContext,
    template_id: String,
    base_revision: u64,
    archived: bool,
    request_id: String,
) -> Result<(), String> {
    require_workspace_principal(ctx)?;
    crate::import::pear_v2::require_no_snapshot_import(ctx).map_err(|_| {
        "IMPORT_IN_PROGRESS: Finish or abort the workspace import before managing components"
    })?;
    let family = ctx
        .db
        .component_template_family()
        .template_id()
        .find(template_id.clone())
        .ok_or("TEMPLATE_NOT_FOUND: Component template unavailable")?;
    require_creator_or_admin(ctx, family.owner, "archive or restore this component")?;
    let fingerprint = state::hash(&format!(
        "trellis.archive.v1\n{template_id}\n{base_revision}\n{archived}"
    ));
    if replay(ctx, &request_id, &fingerprint)? {
        return Ok(());
    }
    if family.revision != base_revision {
        return Err("STALE_REVISION: Component library entry changed; read it again".into());
    }
    let revision = base_revision
        .checked_add(1)
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or("LIMIT: Revision exhausted")?;
    ctx.db
        .component_template_family()
        .template_id()
        .update(ComponentTemplateFamily {
            archived,
            revision,
            updated_at: ctx.timestamp,
            ..family
        });
    receipt(
        ctx,
        request_id,
        fingerprint,
        template_id,
        "archive",
        revision,
    );
    Ok(())
}

pub(crate) fn require_empty_for_import(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.component_template_family().iter().next().is_some()
        || ctx.db.component_template_version().iter().next().is_some()
    {
        return Err("Import refused: workspace component repository is not empty".into());
    }
    Ok(())
}
pub(crate) fn validate_restored(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.component_template_family().iter().count() > 64
        || ctx.db.component_template_version().iter().count() > 256
    {
        return Err("LIMIT: Imported component repository exceeds workspace limits".into());
    }
    for row in ctx.db.component_template_version().iter() {
        if ctx
            .db
            .component_template_family()
            .template_id()
            .find(row.template_id)
            .is_none()
        {
            return Err("INVALID_TEMPLATE: Imported version has no template family".into());
        }
    }
    for family in ctx.db.component_template_family().iter() {
        let version = ctx
            .db
            .component_template_version()
            .key()
            .find(format!("{}@{}", family.template_id, family.latest_version))
            .ok_or("INVALID_TEMPLATE: Imported family is missing its latest version")?;
        let package = state::parse_json(&version.package_json)?;
        if package["name"] != family.name
            || package["definition"]["template"]["description"] != family.description
            || package["tags"]
                != serde_json::from_str::<Value>(&family.tags_json)
                    .map_err(|_| "INVALID_TEMPLATE: Invalid imported tags")?
        {
            return Err(
                "INVALID_TEMPLATE: Family metadata differs from its immutable latest version"
                    .into(),
            );
        }
        for row in ctx
            .db
            .component_template_version()
            .template_id()
            .filter(&family.template_id)
        {
            if export::version(&row.version)? > export::version(&family.latest_version)? {
                return Err("INVALID_TEMPLATE: Family latest version is stale".into());
            }
        }
    }
    for node in ctx
        .db
        .component_node()
        .iter()
        .filter(|n| n.component_type == COMPONENT_TYPE)
    {
        let Ok(value) = serde_json::from_str::<Value>(&node.props) else {
            continue;
        };
        if value["document"]["template"]["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("workspace:"))
        {
            let registry = registry_for_props(ctx, &node.props)?;
            state::parse_with_registry(&node.props, &registry)?;
        }
    }
    Ok(())
}
