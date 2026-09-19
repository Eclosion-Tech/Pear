//! Caller-scoped access projections for public-table RLS. Each filter uses
//! one join: recursively joined RLS passes SQL but fails live subscriptions
//! on SpacetimeDB 2.0.3. Views keep the ancestor walk and participant policy
//! at the data boundary, without a second mutable authorization store.

use crate::access_control::{page_access_rule__view, PageAccessRule};
use crate::ai::ai_user_profile__view;
use crate::auth::user__view;
use crate::conversations::{
    conversation__view, conversation_participant__view, ConversationVisibility,
};
use crate::pages::components::component_node__view;
use crate::pages::schemas::database_schema__view;
use crate::pages::{page__view, Page};
use crate::orcha::orcha_job__view;
use crate::automations::{automation_rule__view, automation_event_queue__view};
use crate::pages::snapshots::page_snapshot__view;
use crate::types::Principal;
use spacetimedb::{client_visibility_filter, view, Filter, Identity, SpacetimeType, ViewContext};
use std::collections::{BTreeMap, HashSet};

#[derive(SpacetimeType)]
pub struct ReadableResource {
    pub id: u64,
}

struct PagePolicy {
    authenticated: bool,
    admin: bool,
    identity: Identity,
    parents: BTreeMap<u64, Option<u64>>,
    rules: BTreeMap<u64, Vec<Identity>>,
}

impl PagePolicy {
    fn load(ctx: &ViewContext) -> Self {
        let identity = ctx.sender();
        let human = ctx.db.user().identity().find(identity);
        let authenticated = human.as_ref().is_some_and(|u| u.is_authenticated)
            || ctx.db.ai_user_profile().identity().find(identity).is_some();
        if !authenticated {
            return Self {
                authenticated: false,
                admin: false,
                identity,
                parents: BTreeMap::new(),
                rules: BTreeMap::new(),
            };
        }
        Self::new(
            identity,
            authenticated,
            human.is_some_and(|u| u.is_authenticated && u.is_admin),
            ctx.db.page().parent_pk().filter(0u64..),
            ctx.db.page_access_rule().page_id().filter(0u64..),
        )
    }

    fn new(
        identity: Identity,
        authenticated: bool,
        admin: bool,
        pages: impl Iterator<Item = Page>,
        rules: impl Iterator<Item = PageAccessRule>,
    ) -> Self {
        let parents = pages.map(|p| (p.id, p.parent_id)).collect();
        let mut by_page: BTreeMap<u64, Vec<Identity>> = BTreeMap::new();
        for rule in rules {
            let Principal::WorkspaceMember(grantee) = rule.principal;
            by_page.entry(rule.page_id).or_default().push(grantee);
        }
        Self {
            authenticated,
            admin,
            identity,
            parents,
            rules: by_page,
        }
    }

    fn can_read(&self, page_id: u64) -> bool {
        if !self.authenticated || !self.parents.contains_key(&page_id) {
            return false;
        }
        if self.admin {
            return true;
        }
        let mut restricted = false;
        let mut seen = HashSet::new();
        let mut current = Some(page_id);
        while let Some(id) = current {
            if !seen.insert(id) {
                return false;
            }
            if let Some(grantees) = self.rules.get(&id) {
                restricted = true;
                if grantees.contains(&self.identity) {
                    return true;
                }
            }
            current = self.parents.get(&id).copied().flatten();
        }
        !restricted
    }
}

#[view(accessor=readable_pages, public)]
pub fn readable_pages(ctx: &ViewContext) -> Vec<ReadableResource> {
    let policy = PagePolicy::load(ctx);
    policy
        .parents
        .keys()
        .filter(|id| policy.can_read(**id))
        .map(|id| ReadableResource { id: *id })
        .collect()
}

#[view(accessor=readable_components, public)]
pub fn readable_components(ctx: &ViewContext) -> Vec<ReadableResource> {
    let policy = PagePolicy::load(ctx);
    if !policy.authenticated {
        return vec![];
    }
    ctx.db
        .component_node()
        .surface_id()
        .filter(0u64..)
        .filter(|n| policy.can_read(n.surface_id))
        .map(|n| ReadableResource { id: n.id })
        .collect()
}

#[view(accessor=readable_schemas, public)]
pub fn readable_schemas(ctx: &ViewContext) -> Vec<ReadableResource> {
    let policy = PagePolicy::load(ctx);
    if !policy.authenticated {
        return vec![];
    }
    ctx.db
        .database_schema()
        .page_id()
        .filter(0u64..)
        .filter(|s| policy.can_read(s.page_id))
        .map(|s| ReadableResource { id: s.id })
        .collect()
}

#[view(accessor=readable_conversations, public)]
pub fn readable_conversations(ctx: &ViewContext) -> Vec<ReadableResource> {
    let policy = PagePolicy::load(ctx);
    if !policy.authenticated {
        return vec![];
    }
    let participating: HashSet<u64> = ctx
        .db
        .conversation_participant()
        .conversation_id()
        .filter(0u64..)
        .filter(|p| p.identity == ctx.sender() && p.left_at.is_none())
        .map(|p| p.conversation_id)
        .collect();
    ctx.db
        .conversation()
        .initiated_by()
        .filter(Identity::ZERO..)
        .filter(|c| {
            participating.contains(&c.id)
                || (matches!(c.visibility, ConversationVisibility::PageInheriting)
                    && c.page_id.is_some_and(|id| policy.can_read(id)))
        })
        .map(|c| ReadableResource { id: c.id })
        .collect()
}

/// Job prompts, results and handoffs are private to the requester and the
/// executing AI identity. Page visibility alone does not grant job access.
#[view(accessor=readable_jobs, public)]
pub fn readable_jobs(ctx: &ViewContext) -> Vec<ReadableResource> {
    let policy = PagePolicy::load(ctx);
    if !policy.authenticated { return vec![]; }
    let mut jobs: BTreeMap<u64, _> = ctx.db.orcha_job()
        .spawning_principal().filter(ctx.sender()).map(|j| (j.id, j)).collect();
    if let Some(ai) = ctx.db.ai_user_profile().identity().find(ctx.sender()) {
        for job in ctx.db.orcha_job().spawning_principal().filter(Identity::ZERO..)
            .filter(|j| j.ai_user_id == Some(ai.ai_user_id)) {
            jobs.insert(job.id, job);
        }
    }
    jobs.into_values()
        .filter(|j| j.page_id.is_none_or(|id| policy.can_read(id)))
        .map(|j| ReadableResource { id: j.id }).collect()
}

#[client_visibility_filter]
const ORCHA_JOB_READ: Filter = Filter::Sql("SELECT orcha_job.* FROM orcha_job JOIN readable_jobs ON orcha_job.id = readable_jobs.id");
#[client_visibility_filter]
const ORCHA_TASK_READ: Filter = Filter::Sql("SELECT orcha_task.* FROM orcha_task JOIN readable_jobs ON orcha_task.job_id = readable_jobs.id");
#[client_visibility_filter]
const ORCHA_CONTEXT_READ: Filter = Filter::Sql("SELECT orcha_shared_context.* FROM orcha_shared_context JOIN readable_jobs ON orcha_shared_context.job_id = readable_jobs.id");

#[view(accessor=readable_automations, public)]
pub fn readable_automations(ctx: &ViewContext) -> Vec<ReadableResource> {
    let policy = PagePolicy::load(ctx);
    if !policy.authenticated { return vec![]; }
    ctx.db.automation_rule().created_by().filter(Identity::ZERO..)
        .filter(|r| policy.admin || r.created_by == ctx.sender() || r.run_as == ctx.sender())
        .map(|r| ReadableResource { id: r.id }).collect()
}

#[view(accessor=readable_automation_events, public)]
pub fn readable_automation_events(ctx: &ViewContext) -> Vec<ReadableResource> {
    let policy = PagePolicy::load(ctx);
    if !policy.authenticated { return vec![]; }
    let rules: BTreeMap<_, _> = ctx.db.automation_rule().created_by().filter(Identity::ZERO..)
        .map(|r| (r.id, r)).collect();
    ctx.db.automation_event_queue().by_rule().filter(0u64..)
        .filter(|e| rules.get(&e.automation_id).is_some_and(|r| {
            let principal = e.invoked_by.unwrap_or(r.run_as);
            (policy.admin || principal == ctx.sender())
                && serde_json::from_str::<serde_json::Value>(&e.trigger_payload).ok()
                    .is_some_and(|p| p.get("page_id").and_then(|v| v.as_u64())
                        .is_none_or(|id| policy.can_read(id)))
        }))
        .map(|e| ReadableResource { id: e.id }).collect()
}

#[view(accessor=readable_review_snapshots, public)]
pub fn readable_review_snapshots(ctx: &ViewContext) -> Vec<ReadableResource> {
    let policy = PagePolicy::load(ctx);
    if !policy.authenticated { return vec![]; }
    ctx.db.page_snapshot().page_id().filter(0u64..)
        .filter(|s| policy.can_read(s.page_id))
        .map(|s| ReadableResource { id: s.id }).collect()
}

#[client_visibility_filter]
const AUTOMATION_RULE_READ: Filter = Filter::Sql("SELECT automation_rule.* FROM automation_rule JOIN readable_automations ON automation_rule.id = readable_automations.id");
#[client_visibility_filter]
const AUTOMATION_ACTION_READ: Filter = Filter::Sql("SELECT automation_action.* FROM automation_action JOIN readable_automations ON automation_action.automation_id = readable_automations.id");
#[client_visibility_filter]
const AUTOMATION_CONDITION_READ: Filter = Filter::Sql("SELECT automation_condition.* FROM automation_condition JOIN readable_automations ON automation_condition.automation_id = readable_automations.id");
#[client_visibility_filter]
const AUTOMATION_CAPABILITY_READ: Filter = Filter::Sql("SELECT automation_capability.* FROM automation_capability JOIN readable_automations ON automation_capability.automation_id = readable_automations.id");
#[client_visibility_filter]
const AUTOMATION_EVENT_READ: Filter = Filter::Sql("SELECT automation_event_queue.* FROM automation_event_queue JOIN readable_automation_events ON automation_event_queue.id = readable_automation_events.id");
#[client_visibility_filter]
const AUTOMATION_LOG_READ: Filter = Filter::Sql("SELECT automation_run_log.* FROM automation_run_log JOIN readable_automation_events ON automation_run_log.queue_id = readable_automation_events.id");
#[client_visibility_filter]
const REVIEW_ANNOTATION_READ: Filter = Filter::Sql("SELECT review_annotation.* FROM review_annotation JOIN readable_review_snapshots ON review_annotation.snapshot_id = readable_review_snapshots.id");

// Direct joins only; publisher access retains the host-provided bypass.
#[client_visibility_filter]
const PAGE_READ: Filter =
    Filter::Sql("SELECT page.* FROM page JOIN readable_pages ON page.id = readable_pages.id");
#[client_visibility_filter]
const PAGE_CONTENT_READ: Filter = Filter::Sql("SELECT page_content.* FROM page_content JOIN readable_pages ON page_content.page_id = readable_pages.id");
#[client_visibility_filter]
const PAGE_YJS_STATE_READ: Filter = Filter::Sql("SELECT page_yjs_state.* FROM page_yjs_state JOIN readable_pages ON page_yjs_state.page_id = readable_pages.id");
#[client_visibility_filter]
const ATTACHMENT_READ: Filter = Filter::Sql("SELECT attachment.* FROM attachment JOIN readable_pages ON attachment.page_id = readable_pages.id");
#[client_visibility_filter]
const PAGE_SNAPSHOT_READ: Filter = Filter::Sql("SELECT page_snapshot.* FROM page_snapshot JOIN readable_pages ON page_snapshot.page_id = readable_pages.id");
#[client_visibility_filter]
const PAGE_ACCESS_RULE_READ: Filter = Filter::Sql("SELECT page_access_rule.* FROM page_access_rule JOIN readable_pages ON page_access_rule.page_id = readable_pages.id");
#[client_visibility_filter]
const BLOCK_ACCESS_RULE_READ: Filter = Filter::Sql("SELECT block_access_rule.* FROM block_access_rule JOIN readable_pages ON block_access_rule.page_id = readable_pages.id");
#[client_visibility_filter]
const PAGE_PROPERTY_VALUE_READ: Filter = Filter::Sql("SELECT page_property_value.* FROM page_property_value JOIN readable_pages ON page_property_value.page_id = readable_pages.id");
#[client_visibility_filter]
const PAGE_PROPERTY_VALUE_HISTORY_READ: Filter = Filter::Sql("SELECT page_property_value_history.* FROM page_property_value_history JOIN readable_pages ON page_property_value_history.page_id = readable_pages.id");
#[client_visibility_filter]
const DATABASE_SCHEMA_READ: Filter = Filter::Sql("SELECT database_schema.* FROM database_schema JOIN readable_pages ON database_schema.page_id = readable_pages.id");
#[client_visibility_filter]
const DATABASE_VIEW_READ: Filter = Filter::Sql("SELECT database_view.* FROM database_view JOIN readable_pages ON database_view.page_id = readable_pages.id");
#[client_visibility_filter]
const COMPONENT_NODE_READ: Filter = Filter::Sql("SELECT component_node.* FROM component_node JOIN readable_pages ON component_node.surface_id = readable_pages.id");
#[client_visibility_filter]
const AI_USER_MEMORY_READ: Filter = Filter::Sql("SELECT ai_user_memory.* FROM ai_user_memory JOIN readable_pages ON ai_user_memory.root_page_id = readable_pages.id");
#[client_visibility_filter]
const COMPONENT_YJS_STATE_READ: Filter = Filter::Sql("SELECT component_yjs_state.* FROM component_yjs_state JOIN readable_components ON component_yjs_state.component_node_id = readable_components.id");
#[client_visibility_filter]
const PROPERTY_DEFINITION_READ: Filter = Filter::Sql("SELECT property_definition.* FROM property_definition JOIN readable_schemas ON property_definition.schema_id = readable_schemas.id");
#[client_visibility_filter]
const CONVERSATION_READ: Filter = Filter::Sql("SELECT conversation.* FROM conversation JOIN readable_conversations ON conversation.id = readable_conversations.id");
#[client_visibility_filter]
const CONVERSATION_MESSAGE_READ: Filter = Filter::Sql("SELECT conversation_message.* FROM conversation_message JOIN readable_conversations ON conversation_message.conversation_id = readable_conversations.id");
#[client_visibility_filter]
const CONVERSATION_PARTICIPANT_READ: Filter = Filter::Sql("SELECT conversation_participant.* FROM conversation_participant JOIN readable_conversations ON conversation_participant.conversation_id = readable_conversations.id");
#[client_visibility_filter]
const CONVERSATION_ATTACHMENT_READ: Filter = Filter::Sql("SELECT conversation_attachment.* FROM conversation_attachment JOIN readable_conversations ON conversation_attachment.conversation_id = readable_conversations.id");
#[client_visibility_filter]
const PAGE_ACCESS_REQUEST_READ: Filter = Filter::Sql("SELECT page_access_request.* FROM page_access_request JOIN readable_conversations ON page_access_request.conversation_id = readable_conversations.id");

#[client_visibility_filter]
const DATABASE_ROW_MARKER_READ: Filter = Filter::Sql("SELECT database_row_marker.* FROM database_row_marker JOIN readable_pages ON database_row_marker.page_id = readable_pages.id");

#[client_visibility_filter]
const AI_EVALUATION_READ: Filter = Filter::Sql("SELECT ai_evaluation.* FROM ai_evaluation JOIN readable_pages ON ai_evaluation.page_id = readable_pages.id");
