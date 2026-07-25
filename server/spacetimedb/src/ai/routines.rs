//! Scheduled AI-user routines: the proactivity primitive. A routine is a
//! standing, human-authored instruction that fires on an interval and posts a
//! trigger into a conversation the AI user participates in — so the AI wakes,
//! runs the instruction through the full conversation harness, and reports back
//! into the thread (reusing the job-completion loop and everything else).
//!
//! Governance posture: the AI user's human creator (or a workspace admin) may
//! create, enable/disable, or delete any routine. The AI user itself may also
//! author and manage routines FOR ITSELF (self-authorship), capped at
//! [`MAX_AI_SELF_ROUTINES`] standing routines and attributed to the AI's
//! identity so the settings surface can show and revoke them. Self-authored
//! routine threads stay anchored to the AI's human creator. A capped AI user's
//! runs are skipped with a visible status rather than silently spending its
//! budget.

use std::time::Duration;

use spacetimedb::{
    reducer, table, Identity, ReducerContext, ScheduleAt, SpacetimeType, Table, Timestamp,
};

use crate::access_control::helpers::require_creator_or_admin;
use crate::ai::memory::ai_user_memory;
use crate::ai::{ai_user_config, AiUserConfig};
use crate::cron::{cron_matches, minute_bucket, parse_cron_fields, parse_timezone};
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

/// Cap on the number of routines an AI user may author for itself, so a
/// self-scheduling loop can't accumulate unbounded standing work. Human
/// creators and admins are not subject to this cap.
const MAX_AI_SELF_ROUTINES: usize = 10;

/// Poll cadence for cron routines: the schedule row ticks every minute and
/// `run_ai_user_routine` fires only when the expression matches (at most once
/// per matching minute). Mirrors the Automations cron tick.
const CRON_POLL_SECS: u64 = 60;

/// How a routine decides when to fire: a fixed interval anchored at creation,
/// or a five-field cron expression evaluated in an IANA timezone (exact
/// wall-clock times, DST-correct).
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum RoutineScheduleKind {
    Interval,
    Cron,
}

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

/// Canned prompt for the memory-consolidation routine (the minimal "dream
/// cycle"): the AI reviews its own memory subtree, merges near-duplicates,
/// prunes stale notes, and writes a dated changelog page — conservatively.
pub const MEMORY_CONSOLIDATION_PROMPT: &str = "Consolidate your private memory. Review your memory \
    subtree (use `search_memory` / `read_memory` to open pages), then do three things and stop: \
    (1) Merge near-duplicates — for each repeated topic keep the best page, fold in anything unique \
    from the others, and blank/retire the redundant ones. (2) Prune notes that are stale, superseded, \
    or were proven wrong. (3) Write a short changelog page under your memory root titled \
    \"Consolidation — <today's date>\" summarizing what you merged, pruned, and kept, and why. Be \
    conservative: when unsure whether a note is still useful, keep it. Do not consolidate the \
    changelog pages themselves.";

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
    // New columns are appended with #[default(...)] — SpacetimeDB AutoMigrate
    // requires a default on added columns to backfill existing rows.
    /// Interval (anchored at creation) or Cron (exact wall-clock schedule).
    #[default(RoutineScheduleKind::Interval)]
    pub schedule_kind: RoutineScheduleKind,
    /// Five-field cron expression; `None` for interval routines.
    #[default(None::<String>)]
    pub cron_expression: Option<String>,
    /// IANA timezone for cron evaluation ("America/New_York"). `None`/blank
    /// means UTC. Must remain last (STDB allows additive changes at the end).
    #[default(None::<String>)]
    pub timezone: Option<String>,
}

/// Authority gate for routine management: the AI user itself (self-authorship),
/// its human creator, or a workspace admin.
fn require_routine_authority(
    ctx: &ReducerContext,
    ai_user: &AiUserConfig,
    action: &str,
) -> Result<(), String> {
    if ctx.sender() == ai_user.identity {
        return Ok(());
    }
    require_creator_or_admin(ctx, ai_user.created_by, action)
}

/// Create a routine for an AI user: creator, admin, or the AI user itself.
/// Self-authored routines are capped at `MAX_AI_SELF_ROUTINES` per AI user.
/// `interval_secs` is floored at `MIN_ROUTINE_INTERVAL_SECS`.
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
    require_routine_authority(ctx, &ai_user, "create routine")?;
    enforce_self_authorship_cap(ctx, &ai_user, ai_user_id)?;

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
        schedule_kind: RoutineScheduleKind::Interval,
        cron_expression: None,
        timezone: None,
    });
    Ok(())
}

/// Create a cron-scheduled routine: fires when `cron_expression` (five-field:
/// minute hour day month weekday) matches the wall clock in `timezone` (IANA
/// name, e.g. "America/New_York"; blank = UTC) — at most once per matching
/// minute. Same authority and self-authorship cap as interval routines. The
/// underlying schedule row polls every `CRON_POLL_SECS`.
#[reducer]
pub fn create_ai_user_routine_cron(
    ctx: &ReducerContext,
    ai_user_id: u64,
    prompt: String,
    cron_expression: String,
    timezone: String,
    conversation_id: Option<u64>,
) -> Result<(), String> {
    let ai_user = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user not found")?;
    require_routine_authority(ctx, &ai_user, "create routine")?;
    enforce_self_authorship_cap(ctx, &ai_user, ai_user_id)?;

    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Routine prompt must not be empty".to_string());
    }
    let expression = cron_expression.trim().to_string();
    parse_cron_fields(&expression)?;
    let tz = timezone.trim().to_string();
    parse_timezone(&tz)?;

    ctx.db.ai_user_routine().insert(AiUserRoutine {
        scheduled_id: 0,
        scheduled_at: Duration::from_secs(CRON_POLL_SECS).into(),
        ai_user_id,
        prompt,
        enabled: true,
        created_by: ctx.sender(),
        conversation_id,
        interval_secs: CRON_POLL_SECS,
        last_run_at: None,
        last_status: None,
        created_at: ctx.timestamp,
        schedule_kind: RoutineScheduleKind::Cron,
        cron_expression: Some(expression),
        timezone: if tz.is_empty() { None } else { Some(tz) },
    });
    Ok(())
}

/// Self-authorship cap: an AI user creating routines for itself may hold at
/// most `MAX_AI_SELF_ROUTINES`. Humans and admins are unaffected.
fn enforce_self_authorship_cap(
    ctx: &ReducerContext,
    ai_user: &AiUserConfig,
    ai_user_id: u64,
) -> Result<(), String> {
    if ctx.sender() != ai_user.identity {
        return Ok(());
    }
    let self_authored = ctx
        .db
        .ai_user_routine()
        .iter()
        .filter(|r| r.ai_user_id == ai_user_id && r.created_by == ai_user.identity)
        .count();
    if self_authored >= MAX_AI_SELF_ROUTINES {
        return Err(format!(
            "AI user already has {MAX_AI_SELF_ROUTINES} self-authored routines; delete one \
             first or ask your creator to add more"
        ));
    }
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

/// Convenience: create the weekly memory-consolidation routine with the canned
/// `MEMORY_CONSOLIDATION_PROMPT`. Requires the AI user to have provisioned
/// memory (nothing to consolidate otherwise). Same creator/admin gate.
#[reducer]
pub fn create_memory_consolidation_routine(
    ctx: &ReducerContext,
    ai_user_id: u64,
    interval_secs: u64,
    conversation_id: Option<u64>,
) -> Result<(), String> {
    if ctx.db.ai_user_memory().ai_user_id().find(ai_user_id).is_none() {
        return Err("AI user has no provisioned memory to consolidate".to_string());
    }
    create_ai_user_routine(
        ctx,
        ai_user_id,
        MEMORY_CONSOLIDATION_PROMPT.to_string(),
        interval_secs,
        conversation_id,
    )
}

/// Enable or disable a routine (creator, admin, or the AI user itself).
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
    require_routine_authority(ctx, &ai_user, "modify routine")?;
    ctx.db.ai_user_routine().scheduled_id().update(AiUserRoutine {
        enabled,
        ..routine
    });
    Ok(())
}

/// Delete a routine (creator, admin, or the AI user itself). Removing the row
/// cancels its schedule.
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
    require_routine_authority(ctx, &ai_user, "delete routine")?;
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

    // Cron routines poll every `CRON_POLL_SECS`: fire only when the expression
    // matches the current minute in the routine's timezone, at most once per
    // matching minute (dedup on last_run_at's minute bucket). Non-matching
    // polls return quietly so last_run_at/last_status keep reflecting real runs.
    if stored.schedule_kind == RoutineScheduleKind::Cron {
        let Some(expr) = stored.cron_expression.as_deref() else {
            record_routine_run(ctx, stored.scheduled_id, "skipped: cron expression missing");
            return Ok(());
        };
        let tz = stored.timezone.as_deref().unwrap_or("");
        if !cron_matches(expr, ctx.timestamp, tz).unwrap_or(false) {
            return Ok(());
        }
        if stored
            .last_run_at
            .is_some_and(|last| minute_bucket(last) == minute_bucket(ctx.timestamp))
        {
            return Ok(());
        }
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
        component_tree_json: None,
        mentions: None,
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
/// conversation if set, else create a page-less thread (a human as initiator,
/// AI user as member) and persist its id back onto the routine. For a
/// self-authored routine (`created_by` is the AI itself) the thread anchors to
/// the AI's human creator, so its output always lands in front of a person.
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

    let human = if routine.created_by == ai_user.identity {
        ai_user.created_by
    } else {
        routine.created_by
    };
    let conv = ctx.db.conversation().insert(Conversation {
        id: next_conversation_id(ctx),
        page_id: None,
        initiated_by: human,
        status: ConversationStatus::Active,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        visibility: ConversationVisibility::Private,
        kind: ConversationKind::AiDm,
        canonical_key: None,
        block_anchor: None,
        model_override: None,
        effort_override: None,
        resolved_by: None,
        resolved_at: None,
    });
    ctx.db.conversation_participant().insert(ConversationParticipant {
        id: next_conversation_participant_id(ctx),
        conversation_id: conv.id,
        identity: human,
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
