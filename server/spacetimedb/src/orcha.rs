//! Orcha coordination layer: jobs, tasks, agents, shared context, and
//! usage events embedded directly in the Pear SpacetimeDB module so the
//! coordination graph and the content graph share a substrate.

use serde::Deserialize;
use spacetimedb::{reducer, table, ReducerContext, Table, Timestamp};

use crate::ai::ai_user_config;
use crate::id_counters::alloc_id;

pub(crate) fn next_orcha_job_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "orcha_job", || {
        ctx.db.orcha_job().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_orcha_task_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "orcha_task", || {
        ctx.db.orcha_task().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_orcha_shared_context_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "orcha_shared_context", || {
        ctx.db.orcha_shared_context().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_orcha_usage_event_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "orcha_usage_event", || {
        ctx.db.orcha_usage_event().iter().map(|r| r.id).max().unwrap_or(0)
    })
}
// ============================================================
// Orcha Coordination Layer
// ============================================================
//
// Orcha tables and reducers are embedded directly in the Pear SpacetimeDB module
// so all Pear objects and Orcha coordination live in the same relational graph.
//
// To use an external Orcha instance instead, set ORCHA_SPACETIMEDB_URI and
// ORCHA_SPACETIMEDB_DB_NAME in your environment — workers and the Next.js server
// will connect there rather than using these embedded tables.
//
// Protocol: https://codeberg.org/Orcha/orcha

/// Deserialization helper for the task_graph_json argument to create_job.
/// Not a SpacetimeType — only used server-side during JSON parsing.
#[derive(Deserialize)]
struct TaskSpec {
    pub description: String,
    pub task_type: String,
    /// Indices into the task_specs array this task depends on (resolved to IDs on insert).
    pub depends_on: Vec<u64>,
    pub required_capabilities: Vec<String>,
}

/// A coordinated unit of AI/worker work. Parent of OrchaTask rows.
#[table(accessor = orcha_job, public)]
pub struct OrchaJob {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub user_id: String,
    pub prompt: String,
    /// Pear page linked to this job — enables native traversal from job → page content.
    #[index(btree)]
    pub page_id: Option<u64>,
    /// "executing" | "complete" | "failed"
    pub status: String,
    pub created_at: Timestamp,
}

/// Atomic unit of work within a job. Supports DAG dependencies via depends_on.
#[table(accessor = orcha_task, public)]
pub struct OrchaTask {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub job_id: u64,
    pub description: String,
    pub task_type: String,
    /// "pending" | "claimed" | "done" | "failed"
    pub status: String,
    /// OrchaTask IDs this task depends on — all must be "done" before this can be claimed.
    pub depends_on: Vec<u64>,
    pub required_capabilities: Vec<String>,
    /// agent_id of the claiming agent, or None if unclaimed.
    pub assigned_to: Option<String>,
    /// Serialized result from the agent, or "ERROR: ..." on failure.
    pub result: Option<String>,
}

/// A registered worker that can claim and execute tasks.
#[table(accessor = orcha_agent, public)]
pub struct OrchaAgent {
    #[primary_key]
    pub id: String,
    pub capabilities: Vec<String>,
    /// "idle" | "busy" | "offline"
    pub status: String,
}

/// Key/value handoff between workers on the same job.
/// Scoped to job_id so the same key name can be used across different jobs.
#[table(accessor = orcha_shared_context, public)]
pub struct OrchaSharedContext {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub job_id: u64,
    pub key: String,
    pub value: String,
    pub created_by: String,
}

/// Per-task usage telemetry. Workers write a row after each task or conversation
/// response completes. Tracks three dimensions:
///   - task count (implicit: one row = one execution)
///   - LLM tokens (zero for non-LLM automations)
///   - wall-clock time
#[table(accessor = orcha_usage_event, public)]
pub struct OrchaUsageEvent {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// The Orcha task this event relates to, or 0 for conversation responses.
    pub task_id: u64,
    /// "orchestrate" | "llm" | "conversation" | custom task types
    pub task_type: String,
    pub agent_id: String,
    /// The AI user whose provider/key was used (if applicable).
    pub ai_user_id: Option<u64>,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub wall_clock_ms: u64,
    pub created_at: Timestamp,
}

/// Check whether all tasks for a job have reached a terminal state and update job status.
/// Called after every task state transition to "done" or "failed".
fn check_orcha_job_completion(ctx: &ReducerContext, job_id: u64) {
    let tasks: Vec<OrchaTask> = ctx.db.orcha_task().job_id().filter(&job_id).collect();
    if tasks.is_empty() {
        return;
    }
    let all_terminal = tasks.iter().all(|t| t.status == "done" || t.status == "failed");
    if !all_terminal {
        return;
    }
    let any_failed = tasks.iter().any(|t| t.status == "failed");
    if let Some(job) = ctx.db.orcha_job().id().find(job_id) {
        ctx.db.orcha_job().id().update(OrchaJob {
            status: if any_failed {
                "failed".to_string()
            } else {
                "complete".to_string()
            },
            ..job
        });
        log::info!("Orcha: job {} complete (any_failed={})", job_id, any_failed);
    }
}

/// Create a job with a full task graph.
///
/// `task_graph_json`: JSON array of objects with shape:
/// `{ "description": "...", "task_type": "...", "depends_on": [0, 1], "required_capabilities": ["llm"] }`
/// `depends_on` entries are zero-based indices into the array — resolved to actual task IDs on insert.
///
/// `page_id`: optional Pear page this job acts on (schema generation, summarization, NL filter, etc.)
#[reducer]
pub fn create_job(
    ctx: &ReducerContext,
    user_id: String,
    prompt: String,
    page_id: Option<u64>,
    task_graph_json: String,
) -> Result<(), String> {
    let specs: Vec<TaskSpec> = serde_json::from_str(&task_graph_json)
        .map_err(|e| format!("Invalid task graph JSON: {}", e))?;

    let job = ctx.db.orcha_job().insert(OrchaJob {
        id: next_orcha_job_id(ctx),
        user_id,
        prompt,
        page_id,
        status: "executing".to_string(),
        created_at: ctx.timestamp,
    });
    let job_id = job.id;

    // Insert tasks with empty depends_on first to get real IDs.
    let mut task_ids: Vec<u64> = Vec::with_capacity(specs.len());
    for spec in &specs {
        let task = ctx.db.orcha_task().insert(OrchaTask {
            id: next_orcha_task_id(ctx),
            job_id,
            description: spec.description.clone(),
            task_type: spec.task_type.clone(),
            status: "pending".to_string(),
            depends_on: vec![],
            required_capabilities: spec.required_capabilities.clone(),
            assigned_to: None,
            result: None,
        });
        task_ids.push(task.id);
    }

    // Second pass: resolve depends_on indices → actual OrchaTask IDs.
    for (i, &task_id) in task_ids.iter().enumerate() {
        let resolved: Vec<u64> = specs[i]
            .depends_on
            .iter()
            .filter_map(|&idx| task_ids.get(idx as usize).copied())
            .collect();
        if !resolved.is_empty() {
            if let Some(row) = ctx.db.orcha_task().id().find(task_id) {
                ctx.db.orcha_task().id().update(OrchaTask {
                    depends_on: resolved,
                    ..row
                });
            }
        }
    }

    log::info!("Orcha: created job {} with {} tasks", job_id, task_ids.len());
    Ok(())
}

/// Register or update an agent's capabilities. Safe to call on reconnect.
#[reducer]
pub fn register_agent(
    ctx: &ReducerContext,
    agent_id: String,
    capabilities: Vec<String>,
) -> Result<(), String> {
    if let Some(existing) = ctx.db.orcha_agent().id().find(agent_id.clone()) {
        ctx.db.orcha_agent().id().update(OrchaAgent {
            capabilities,
            status: "idle".to_string(),
            ..existing
        });
    } else {
        ctx.db.orcha_agent().insert(OrchaAgent {
            id: agent_id,
            capabilities,
            status: "idle".to_string(),
        });
    }
    Ok(())
}

/// Claim a pending task. Fails if already claimed, dependencies unmet, or agent lacks capabilities.
#[reducer]
pub fn claim_task(ctx: &ReducerContext, agent_id: String, task_id: u64) -> Result<(), String> {
    let task = ctx
        .db
        .orcha_task()
        .id()
        .find(task_id)
        .ok_or("Task not found")?;
    if task.assigned_to.is_some() {
        return Err("Task already claimed".to_string());
    }
    for &dep_id in &task.depends_on {
        let dep = ctx
            .db
            .orcha_task()
            .id()
            .find(dep_id)
            .ok_or_else(|| format!("Dependency task {} not found", dep_id))?;
        if dep.status != "done" {
            return Err(format!(
                "Dependency task {} not yet done (status: {})",
                dep_id, dep.status
            ));
        }
    }
    let agent = ctx
        .db
        .orcha_agent()
        .id()
        .find(agent_id.clone())
        .ok_or("Agent not found")?;
    for cap in &task.required_capabilities {
        if !agent.capabilities.contains(cap) {
            return Err(format!("Agent missing required capability: {}", cap));
        }
    }
    ctx.db.orcha_task().id().update(OrchaTask {
        assigned_to: Some(agent_id),
        status: "claimed".to_string(),
        ..task
    });
    Ok(())
}

/// Submit a completed task result. Triggers job completion check.
#[reducer]
pub fn submit_result(
    ctx: &ReducerContext,
    agent_id: String,
    task_id: u64,
    result: String,
) -> Result<(), String> {
    let task = ctx
        .db
        .orcha_task()
        .id()
        .find(task_id)
        .ok_or("Task not found")?;
    if task.assigned_to.as_deref() != Some(&agent_id) {
        return Err("Task not claimed by this agent".to_string());
    }
    let job_id = task.job_id;
    ctx.db.orcha_task().id().update(OrchaTask {
        result: Some(result),
        status: "done".to_string(),
        ..task
    });
    check_orcha_job_completion(ctx, job_id);
    Ok(())
}

/// Mark a task as failed. Triggers job completion check.
#[reducer]
pub fn fail_task(
    ctx: &ReducerContext,
    agent_id: String,
    task_id: u64,
    error: String,
) -> Result<(), String> {
    let task = ctx
        .db
        .orcha_task()
        .id()
        .find(task_id)
        .ok_or("Task not found")?;
    if task.assigned_to.as_deref() != Some(&agent_id) {
        return Err("Task not claimed by this agent".to_string());
    }
    let job_id = task.job_id;
    ctx.db.orcha_task().id().update(OrchaTask {
        result: Some(format!("ERROR: {}", error)),
        status: "failed".to_string(),
        ..task
    });
    check_orcha_job_completion(ctx, job_id);
    Ok(())
}

/// Dynamically add tasks to an existing job.
///
/// Called by an orchestrate worker after it has decomposed the user's prompt
/// into a task graph. The `task_graph_json` format is identical to `create_job`:
/// a JSON array of `{ description, task_type, depends_on: [index], required_capabilities }`.
/// `depends_on` indices are resolved relative to the NEW tasks in this batch —
/// they do not reference existing tasks in the job.
#[reducer]
pub fn add_tasks_to_job(
    ctx: &ReducerContext,
    job_id: u64,
    task_graph_json: String,
) -> Result<(), String> {
    ctx.db
        .orcha_job()
        .id()
        .find(job_id)
        .ok_or("Job not found")?;

    let specs: Vec<TaskSpec> = serde_json::from_str(&task_graph_json)
        .map_err(|e| format!("Invalid task graph JSON: {}", e))?;

    let mut new_task_ids: Vec<u64> = Vec::with_capacity(specs.len());
    for spec in &specs {
        let task = ctx.db.orcha_task().insert(OrchaTask {
            id: next_orcha_task_id(ctx),
            job_id,
            description: spec.description.clone(),
            task_type: spec.task_type.clone(),
            status: "pending".to_string(),
            depends_on: vec![],
            required_capabilities: spec.required_capabilities.clone(),
            assigned_to: None,
            result: None,
        });
        new_task_ids.push(task.id);
    }

    // Resolve depends_on indices → actual OrchaTask IDs within this batch.
    for (i, &task_id) in new_task_ids.iter().enumerate() {
        let resolved: Vec<u64> = specs[i]
            .depends_on
            .iter()
            .filter_map(|&idx| new_task_ids.get(idx as usize).copied())
            .collect();
        if !resolved.is_empty() {
            if let Some(row) = ctx.db.orcha_task().id().find(task_id) {
                ctx.db.orcha_task().id().update(OrchaTask {
                    depends_on: resolved,
                    ..row
                });
            }
        }
    }

    log::info!(
        "Orcha: added {} tasks to job {}",
        new_task_ids.len(),
        job_id
    );
    Ok(())
}

/// Write a key/value entry to the shared context for a job.
/// Overwrites any existing entry for the same job + key pair.
#[reducer]
pub fn set_shared_context(
    ctx: &ReducerContext,
    job_id: u64,
    key: String,
    value: String,
    created_by: String,
) -> Result<(), String> {
    ctx.db
        .orcha_job()
        .id()
        .find(job_id)
        .ok_or("Job not found")?;
    let existing = ctx
        .db
        .orcha_shared_context()
        .job_id()
        .filter(&job_id)
        .find(|e| e.key == key);
    match existing {
        Some(row) => {
            ctx.db
                .orcha_shared_context()
                .id()
                .update(OrchaSharedContext {
                    value,
                    created_by,
                    ..row
                });
        }
        None => {
            ctx.db.orcha_shared_context().insert(OrchaSharedContext {
                id: next_orcha_shared_context_id(ctx),
                job_id,
                key,
                value,
                created_by,
            });
        }
    }
    Ok(())
}

/// Record a usage event for a completed task or conversation response.
///
/// Phase A cost-cap surface: when the AI user has a `monthly_token_cap` set,
/// the reducer logs (but does not refuse) the event so the UI can render
/// the warning / hard-stop pills. Refusal happens at task acceptance time
/// in `claim_task`; recording usage *after* the work is done would penalise
/// honest reporting, so we always insert the row.
#[reducer]
pub fn record_usage_event(
    ctx: &ReducerContext,
    task_id: u64,
    task_type: String,
    agent_id: String,
    ai_user_id: Option<u64>,
    tokens_in: u64,
    tokens_out: u64,
    wall_clock_ms: u64,
) -> Result<(), String> {
    if let Some(uid) = ai_user_id {
        if let Some(cap) = ctx
            .db
            .ai_user_config()
            .id()
            .find(uid)
            .and_then(|c| c.monthly_token_cap)
        {
            let used = month_to_date_tokens(ctx, uid);
            let projected = used + tokens_in + tokens_out;
            if projected > cap {
                log::warn!(
                    "[cost] ai_user {} projected to exceed monthly_token_cap ({} > {})",
                    uid,
                    projected,
                    cap,
                );
            } else if projected * 5 >= cap * 4 {
                log::info!(
                    "[cost] ai_user {} at {}% of monthly_token_cap ({} of {})",
                    uid,
                    projected * 100 / cap.max(1),
                    projected,
                    cap,
                );
            }
        }
    }
    ctx.db.orcha_usage_event().insert(OrchaUsageEvent {
        id: next_orcha_usage_event_id(ctx),
        task_id,
        task_type,
        agent_id,
        ai_user_id,
        tokens_in,
        tokens_out,
        wall_clock_ms,
        created_at: ctx.timestamp,
    });
    Ok(())
}

/// Sum tokens_in + tokens_out for `ai_user_id` for the current calendar
/// month (UTC). O(N) over events; for a per-AI-user btree index this drops
/// to O(month-rows) but the ergonomics of `iter().filter` are fine until
/// the table grows past ~10k rows per workspace.
fn month_to_date_tokens(ctx: &ReducerContext, ai_user_id: u64) -> u64 {
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    // Roughly the first of the month at UTC midnight; we err on the side of
    // including a few extra days at month boundaries rather than dropping
    // events the user can see in their dashboard.
    let micros_per_day: i64 = 86_400 * 1_000_000;
    let month_start = now_micros.saturating_sub(31 * micros_per_day);
    ctx.db
        .orcha_usage_event()
        .iter()
        .filter(|e| e.ai_user_id == Some(ai_user_id))
        .filter(|e| e.created_at.to_micros_since_unix_epoch() >= month_start)
        .map(|e| e.tokens_in + e.tokens_out)
        .sum()
}

