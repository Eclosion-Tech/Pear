//! Background Notion-import job queue.
//!
//! The web app enqueues a job carrying the AES-256-GCM **ciphertext** of the
//! user's Notion OAuth token (the decryption key lives only in the worker's
//! environment — plaintext never touches SpacetimeDB). The workspace worker's
//! admin connection claims the job, fetches + transforms the Notion content
//! off-platform (no serverless timeout), streams progress onto the row, and
//! finishes by applying the payload through the same offset-remapping importer
//! as the interactive `import_notion` path. The requesting human watches
//! progress live over their subscription to this table.
//!
//! Visibility: RLS exposes a job only to its requester; the module publisher
//! (the worker's admin token) bypasses the filter. Terminal transitions blank
//! the ciphertext so it does not outlive the run.

use spacetimedb::{
    client_visibility_filter, reducer, table, Filter, Identity, ReducerContext, SpacetimeType,
    Table, Timestamp,
};

use crate::import::notion_v1::apply_notion_snapshot_for_job;
use crate::module_install::sender_is_module_publisher;
use crate::user;

/// Jobs stuck in a non-terminal state longer than this are considered dead
/// (worker crashed / redeployed mid-run) and may be superseded by a new job.
const STALE_JOB_SECS: i64 = 30 * 60;

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum NotionImportJobStatus {
    Pending,
    Running,
    Done,
    Failed,
}

/// Requester sees only their own jobs; the publisher (worker) sees all rows.
#[client_visibility_filter]
const NOTION_IMPORT_JOB_FILTER: Filter =
    Filter::Sql("SELECT * FROM notion_import_job WHERE requested_by = :sender");

#[table(accessor = notion_import_job, public)]
pub struct NotionImportJob {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Human who requested the import; imported content is attributed to them.
    pub requested_by: Identity,
    /// AES-256-GCM ciphertext of the Notion OAuth token (base64). Blanked on
    /// completion/failure. Useless without the key in the worker environment.
    pub encrypted_token_b64: String,
    /// Source Notion workspace name — container title + display.
    pub source_name: String,
    /// Workspace slug, used to build attachment URLs in transformed content.
    pub workspace_slug: String,
    pub status: NotionImportJobStatus,
    /// Human-readable progress line ("Fetching blocks 120/596…").
    pub stage: String,
    pub pages_done: u32,
    pub pages_total: u32,
    pub error: Option<String>,
    /// Root container page of the finished import.
    pub container_page_id: Option<u64>,
    /// Worker instance that claimed the job.
    pub claimed_by: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

fn require_publisher(ctx: &ReducerContext, action: &str) -> Result<(), String> {
    if sender_is_module_publisher(ctx) {
        Ok(())
    } else {
        Err(format!("Only the workspace worker can {action}"))
    }
}

fn job_is_stale(ctx: &ReducerContext, job: &NotionImportJob) -> bool {
    let age_micros = ctx
        .timestamp
        .to_micros_since_unix_epoch()
        .saturating_sub(job.updated_at.to_micros_since_unix_epoch());
    age_micros > STALE_JOB_SECS * 1_000_000
}

/// Enqueue a background Notion import. Caller must be an authenticated user.
/// One live job per workspace: an existing Pending/Running job blocks a new
/// one unless it has gone stale, in which case it is marked Failed first.
#[reducer]
pub fn create_notion_import_job(
    ctx: &ReducerContext,
    encrypted_token_b64: String,
    source_name: String,
    workspace_slug: String,
) -> Result<(), String> {
    let me = ctx.sender();
    let authed = ctx
        .db
        .user()
        .identity()
        .find(me)
        .map(|u| u.is_authenticated)
        .unwrap_or(false);
    if !authed {
        return Err("You must be logged in to import from Notion.".to_string());
    }
    if encrypted_token_b64.trim().is_empty() {
        return Err("Missing encrypted Notion token".to_string());
    }

    let live: Vec<NotionImportJob> = ctx
        .db
        .notion_import_job()
        .iter()
        .filter(|j| {
            matches!(
                j.status,
                NotionImportJobStatus::Pending | NotionImportJobStatus::Running
            )
        })
        .collect();
    for job in live {
        if job_is_stale(ctx, &job) {
            ctx.db.notion_import_job().id().update(NotionImportJob {
                status: NotionImportJobStatus::Failed,
                error: Some("Superseded: no progress for 30 minutes".to_string()),
                encrypted_token_b64: String::new(),
                updated_at: ctx.timestamp,
                ..job
            });
        } else {
            return Err("A Notion import is already in progress for this workspace.".to_string());
        }
    }

    ctx.db.notion_import_job().insert(NotionImportJob {
        id: 0,
        requested_by: me,
        encrypted_token_b64,
        source_name: source_name.trim().to_string(),
        workspace_slug: workspace_slug.trim().to_string(),
        status: NotionImportJobStatus::Pending,
        stage: "Queued — waiting for the workspace worker".to_string(),
        pages_done: 0,
        pages_total: 0,
        error: None,
        container_page_id: None,
        claimed_by: None,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    Ok(())
}

/// Worker claims a pending job (Pending → Running).
#[reducer]
pub fn claim_notion_import_job(
    ctx: &ReducerContext,
    job_id: u64,
    worker_id: String,
) -> Result<(), String> {
    require_publisher(ctx, "claim import jobs")?;
    let job = ctx
        .db
        .notion_import_job()
        .id()
        .find(job_id)
        .ok_or("Import job not found")?;
    if job.status != NotionImportJobStatus::Pending {
        return Err("Import job is not pending".to_string());
    }
    ctx.db.notion_import_job().id().update(NotionImportJob {
        status: NotionImportJobStatus::Running,
        claimed_by: Some(worker_id),
        stage: "Claimed — starting fetch".to_string(),
        updated_at: ctx.timestamp,
        ..job
    });
    Ok(())
}

/// Worker streams progress onto the row.
#[reducer]
pub fn update_notion_import_job(
    ctx: &ReducerContext,
    job_id: u64,
    stage: String,
    pages_done: u32,
    pages_total: u32,
) -> Result<(), String> {
    require_publisher(ctx, "update import jobs")?;
    let job = ctx
        .db
        .notion_import_job()
        .id()
        .find(job_id)
        .ok_or("Import job not found")?;
    if job.status != NotionImportJobStatus::Running {
        return Err("Import job is not running".to_string());
    }
    ctx.db.notion_import_job().id().update(NotionImportJob {
        stage,
        pages_done,
        pages_total,
        updated_at: ctx.timestamp,
        ..job
    });
    Ok(())
}

/// Worker delivers the transformed payload: applies it atomically through the
/// shared offset-remapping importer, records the container page, and blanks
/// the token ciphertext.
#[reducer]
pub fn complete_notion_import_job(
    ctx: &ReducerContext,
    job_id: u64,
    snapshot_json: String,
) -> Result<(), String> {
    require_publisher(ctx, "complete import jobs")?;
    let job = ctx
        .db
        .notion_import_job()
        .id()
        .find(job_id)
        .ok_or("Import job not found")?;
    if job.status != NotionImportJobStatus::Running {
        return Err("Import job is not running".to_string());
    }
    let container = apply_notion_snapshot_for_job(ctx, &snapshot_json)?;
    ctx.db.notion_import_job().id().update(NotionImportJob {
        status: NotionImportJobStatus::Done,
        stage: "Import complete".to_string(),
        container_page_id: Some(container),
        encrypted_token_b64: String::new(),
        updated_at: ctx.timestamp,
        ..job
    });
    Ok(())
}

/// Worker marks a job failed (token ciphertext is blanked).
#[reducer]
pub fn fail_notion_import_job(
    ctx: &ReducerContext,
    job_id: u64,
    error: String,
) -> Result<(), String> {
    require_publisher(ctx, "fail import jobs")?;
    let job = ctx
        .db
        .notion_import_job()
        .id()
        .find(job_id)
        .ok_or("Import job not found")?;
    ctx.db.notion_import_job().id().update(NotionImportJob {
        status: NotionImportJobStatus::Failed,
        error: Some(error),
        encrypted_token_b64: String::new(),
        updated_at: ctx.timestamp,
        ..job
    });
    Ok(())
}
