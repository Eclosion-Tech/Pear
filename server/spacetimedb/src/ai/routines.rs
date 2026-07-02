//! Scheduled AI-user routines: the proactivity primitive. A routine is a
//! standing, human-authored instruction that fires on an interval and posts a
//! trigger into a conversation the AI user participates in — so the AI wakes,
//! runs the instruction through the full conversation harness, and reports back
//! into the thread (reusing the job-completion loop and everything else).
//!
//! Governance posture mirrors access-rule authorship: only the AI user's human
//! creator (or a workspace admin) may create, enable/disable, or delete a
//! routine — the AI user cannot schedule its own work. A capped AI user's runs
//! are skipped with a visible status rather than silently spending its budget.

use std::time::Duration;

use spacetimedb::{reducer, table, Identity, ReducerContext, ScheduleAt, Table, Timestamp};

use crate::access_control::helpers::require_creator_or_admin;
use crate::ai::{ai_user_config, AiUserConfig};
use crate::conversations::{
    conversation, conversation_message, conversation_participant, next_conversation_id,
    next_conversation_message_id, next_conversation_participant_id, Conversation, ConversationKind,
    ConversationMessage, ConversationParticipant, ConversationStatus, ConversationVisibility,
    MessageSender, MessageStatus, ParticipantRole,
};
use crate::orcha::ai_user_at_hard_cap;

/// Floor on the routine interval — routines are ambient background work, not a
/// tight loop; this bounds how often even a mistaken config can fire.
const MIN_ROUTINE_INTERVAL_SECS: u64 = 300;

/// Canned prompt for the first routine consumer: structural-sensor triage. The
/// AI reviews open findings, fixes the trivial ones with receipts, and drafts a
/// proposal for the rest instead of acting on anything ambiguous.
pub const SENSOR_TRIAGE_PROMPT: &str = "Review the workspace's open structural-sensor findings with \
    `list_sensor_findings`. For each finding: if it is trivial and clearly safe to fix directly \
    (e.g. an orphaned page that obviously belongs under a known parent), fix it with the appropriate \
    tool and note exactly what you did and why. For anything ambiguous or higher blast-radius, do NOT \
    change it — instead compile a short triage summary grouped by sensor kind, citing finding ids and \
    target ids, and post it here as a proposal for a human to review. Be concise. If there are no open \
    findings, say so in one line.";

/// A scheduled, human-authored routine for one AI user. This IS the schedule
/// row (SpacetimeDB `scheduled` table): `scheduled_at` carries the recurring
/// interval, and `run_ai_user_routine` receives the row when it fires.
#[table(accessor = ai_user_routine, public, scheduled(run_ai_user_routine))]
pub struct AiUserRoutine {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    /// Recurring interval schedule. Required by the scheduled-table macro.
    pub scheduled_at: ScheduleAt,
    /// The AI user this routine drives.
    pub ai_user_id: u64,
    /// The standing instruction posted into the routine conversation each run.
    pub prompt: String,
    /// When false the tick still fires but is skipped — a cheap pause that keeps
    /// the schedule intact instead of dropping and recreating it.
    pub enabled: bool,
    /// Human who authored the routine; backs the creator/admin edit gate.
    pub created_by: Identity,
    /// Conversation to post into. `None` until the first run auto-creates a
    /// page-less routine thread between the creator and the AI user.
    pub conversation_id: Option<u64>,
    /// The interval in seconds (kept alongside `scheduled_at` for display/edit).
    pub interval_secs: u64,
    pub last_run_at: Option<Timestamp>,
    /// Short status of the most recent tick ("ran" | "skipped: disabled" |
    /// "skipped: token cap" | …) so the UI can show what happened.
    pub last_status: Option<String>,
    pub created_at: Timestamp,
}

/// Create a routine for an AI user. Creator-or-admin only (the AI user cannot
/// schedule its own work). `interval_secs` is floored at `MIN_ROUTINE_INTERVAL_SECS`.
#[reducer]
pub fn create_ai_user_routine(
    ctx: &ReducerContext,
    ai_user_id: u64,
    prompt: String,
    interval_secs: u64,
    conversation_id: Option<u64>,
) -> Result<(), String> {
    let ai_user = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user not found")?;
    require_creator_or_admin(ctx, ai_user.created_by, "create routine")?;

    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Routine prompt must not be empty".to_string());
    }
    let interval = interval_secs.max(MIN_ROUTINE_INTERVAL_SECS);

    ctx.db.ai_user_routine().insert(AiUserRoutine {
        scheduled_id: 0,
        scheduled_at: Duration::from_secs(interval).into(),
        ai_user_id,
        prompt,
        enabled: true,
        created_by: ctx.sender(),
        conversation_id,
        interval_secs: interval,
        last_run_at: None,
        last_status: None,
        created_at: ctx.timestamp,
    });
    Ok(())
}

/// Convenience: create the structural-sensor triage routine (the first
/// consumer) with the canned `SENSOR_TRIAGE_PROMPT`. Same creator/admin gate.
#[reducer]
pub fn create_sensor_triage_routine(
    ctx: &ReducerContext,
    ai_user_id: u64,
    interval_secs: u64,
    conversation_id: Option<u64>,
) -> Result<(), String> {
    create_ai_user_routine(
        ctx,
        ai_user_id,
        SENSOR_TRIAGE_PROMPT.to_string(),
        interval_secs,
        conversation_id,
    )
}

/// Enable or disable a routine (creator/admin only).
#[reducer]
pub fn set_ai_user_routine_enabled(
    ctx: &ReducerContext,
    scheduled_id: u64,
    enabled: bool,
) -> Result<(), String> {
    let routine = ctx
        .db
        .ai_user_routine()
        .scheduled_id()
        .find(scheduled_id)
        .ok_or("Routine not found")?;
    let ai_user = ctx
        .db
        .ai_user_config()
        .id()
        .find(routine.ai_user_id)
        .ok_or("AI user not found")?;
    require_creator_or_admin(ctx, ai_user.created_by, "modify routine")?;
    ctx.db.ai_user_routine().scheduled_id().update(AiUserRoutine {
        enabled,
        ..routine
    });
    Ok(())
}

/// Delete a routine (creator/admin only). Removing the row cancels its schedule.
#[reducer]
pub fn delete_ai_user_routine(ctx: &ReducerContext, scheduled_id: u64) -> Result<(), String> {
    let routine = ctx
        .db
        .ai_user_routine()
        .scheduled_id()
        .find(scheduled_id)
        .ok_or("Routine not found")?;
    let ai_user = ctx
        .db
        .ai_user_config()
        .id()
        .find(routine.ai_user_id)
        .ok_or("AI user not found")?;
    require_creator_or_admin(ctx, ai_user.created_by, "delete routine")?;
    ctx.db.ai_user_routine().scheduled_id().delete(scheduled_id);
    Ok(())
}

/// Scheduled tick: fire one routine. Posts a `System("routine")` trigger with
/// the routine's prompt into its conversation; the AI user's worker treats that
/// as a turn trigger, runs the instruction, and reports back.
#[reducer]
pub fn run_ai_user_routine(ctx: &ReducerContext, routine: AiUserRoutine) -> Result<(), String> {
    // Trust only the stored row: a client that calls this reducer directly could
    // pass a fabricated `AiUserRoutine` (different ai_user/prompt). The scheduler
    // passes the real row, but we re-read it and ignore the argument's mutable
    // fields. If the row is gone (deleted), there's nothing to do.
    let Some(stored) = ctx
        .db
        .ai_user_routine()
        .scheduled_id()
        .find(routine.scheduled_id)
    else {
        return Ok(());
    };

    if !stored.enabled {
        record_routine_run(ctx, stored.scheduled_id, "skipped: disabled");
        return Ok(());
    }

    let Some(ai_user) = ctx.db.ai_user_config().id().find(stored.ai_user_id) else {
        record_routine_run(ctx, stored.scheduled_id, "skipped: AI user missing");
        return Ok(());
    };

    // Respect the monthly token cap: a capped AI user's routines skip with a
    // visible status rather than quietly spending budget.
    if ai_user_at_hard_cap(ctx, stored.ai_user_id) {
        record_routine_run(ctx, stored.scheduled_id, "skipped: token cap");
        log::info!(
            "routine {}: skipped (AI user {} at token cap)",
            stored.scheduled_id,
            stored.ai_user_id
        );
        return Ok(());
    }

    let conversation_id = ensure_routine_conversation(ctx, &stored, &ai_user);
    ctx.db.conversation_message().insert(ConversationMessage {
        id: next_conversation_message_id(ctx),
        conversation_id,
        sender: MessageSender::System("routine".to_string()),
        content: stored.prompt.clone(),
        job_id: None,
        created_at: ctx.timestamp,
        status: MessageStatus::Complete,
        thinking: None,
        tool_calls_json: None,
        timeline_json: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        linked_conversation_id: None,
    });
    if let Some(conv) = ctx.db.conversation().id().find(conversation_id) {
        ctx.db.conversation().id().update(Conversation {
            updated_at: ctx.timestamp,
            ..conv
        });
    }
    record_routine_run(ctx, stored.scheduled_id, "ran");
    log::info!(
        "routine {}: posted trigger into conversation {}",
        stored.scheduled_id,
        conversation_id
    );
    Ok(())
}

/// Stamp `last_run_at` / `last_status` on a routine after a tick.
fn record_routine_run(ctx: &ReducerContext, scheduled_id: u64, status: &str) {
    if let Some(current) = ctx.db.ai_user_routine().scheduled_id().find(scheduled_id) {
        ctx.db.ai_user_routine().scheduled_id().update(AiUserRoutine {
            last_run_at: Some(ctx.timestamp),
            last_status: Some(status.to_string()),
            ..current
        });
    }
}

/// Resolve the conversation to post into: reuse the routine's active
/// conversation if set, else create a page-less thread (creator as initiator,
/// AI user as member) and persist its id back onto the routine.
fn ensure_routine_conversation(
    ctx: &ReducerContext,
    routine: &AiUserRoutine,
    ai_user: &AiUserConfig,
) -> u64 {
    if let Some(cid) = routine.conversation_id {
        if let Some(conv) = ctx.db.conversation().id().find(cid) {
            if conv.status == ConversationStatus::Active {
                return cid;
            }
        }
    }

    let conv = ctx.db.conversation().insert(Conversation {
        id: next_conversation_id(ctx),
        page_id: None,
        initiated_by: routine.created_by,
        status: ConversationStatus::Active,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        visibility: ConversationVisibility::Private,
        kind: ConversationKind::AiDm,
        canonical_key: None,
        block_anchor: None,
        model_override: None,
        effort_override: None,
    });
    ctx.db.conversation_participant().insert(ConversationParticipant {
        id: next_conversation_participant_id(ctx),
        conversation_id: conv.id,
        identity: routine.created_by,
        role: ParticipantRole::Initiator,
        joined_at: ctx.timestamp,
        last_viewed_message_id: None,
        left_at: None,
    });
    ctx.db.conversation_participant().insert(ConversationParticipant {
        id: next_conversation_participant_id(ctx),
        conversation_id: conv.id,
        identity: ai_user.identity,
        role: ParticipantRole::Member,
        joined_at: ctx.timestamp,
        last_viewed_message_id: None,
        left_at: None,
    });

    if let Some(current) = ctx.db.ai_user_routine().scheduled_id().find(routine.scheduled_id) {
        ctx.db.ai_user_routine().scheduled_id().update(AiUserRoutine {
            conversation_id: Some(conv.id),
            ..current
        });
    }
    conv.id
}
