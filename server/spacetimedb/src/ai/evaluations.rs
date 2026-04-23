//! Cached evaluations of AI primitives over rows. The same
//! `(primitive, inputs, model, prompt_version)` produces the same
//! `input_hash`, so two `Ai` cells in different rows with the same
//! inputs share an evaluation.

use spacetimedb::{reducer, table, Identity, ReducerContext, Table, Timestamp};

use crate::access_control::helpers::require_page_write;
use crate::id_counters::alloc_id;
use crate::pages::schemas::{
    next_page_property_value_history_id, next_page_property_value_id, page_property_value,
    page_property_value_history, property_definition, AiPrimitive, AiPropertyValue,
    PagePropertyValue, PagePropertyValueHistory, PropertyValue,
};
use crate::pages::ActorType;

pub(crate) fn next_ai_evaluation_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "ai_evaluation", || {
        ctx.db.ai_evaluation().iter().map(|r| r.id).max().unwrap_or(0)
    })
}
/// Cached evaluation of an AI primitive over a specific row. The cache key
/// is `input_hash = sha256(primitive || NUL || model || NUL || prompt_version || NUL || serialized_inputs)`.
/// The same `(primitive, inputs, model, prompt_version)` produces the same
/// `input_hash`, so two `Ai` cells in different rows that happened to have
/// the same inputs share an evaluation for free. Cross-workspace
/// sharing is opt-in via `ai_user_config.allow_evaluation_sharing` and
/// is the responsibility of whatever external service consumes those
/// rows; pear core itself never publishes them.
///
/// `is_stale` flips to `true` when an upstream input changes; recompute
/// inserts a fresh row and the prior row is preserved as history (cost +
/// provenance trail). Retention policy: keep all eval rows for now;
/// thinning is a Phase B/C polish concern once volume is real.
#[table(
    accessor = ai_evaluation,
    public,
    index(accessor = ai_evaluation_input_hash, btree(columns = [input_hash])),
    index(accessor = ai_evaluation_property_page,
          btree(columns = [property_definition_id, page_id])),
)]
pub struct AiEvaluation {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// PropertyDefinition.id of the AI column this evaluation belongs to.
    #[index(btree)]
    pub property_definition_id: u64,
    /// Page (row) the evaluation is for.
    #[index(btree)]
    pub page_id: u64,
    /// SHA-256 hex of the canonicalised cache key.
    pub input_hash: String,
    pub primitive: AiPrimitive,
    pub model: String,
    /// Monotonically incremented when the operator edits `prompt_template`
    /// in the column config. Distinguishes "same inputs, new prompt".
    pub prompt_version: u32,
    /// Final tool output as serialized JSON string.
    pub output: String,
    /// Tokens consumed (prompt + completion).
    pub input_tokens: u32,
    pub output_tokens: u32,
    /// Cost in USD micro-cents (10^-6 USD) — integer storage avoids
    /// floating-point drift in aggregations.
    pub cost_microcents: u64,
    pub wall_clock_ms: u32,
    pub created_at: Timestamp,
    /// Identity of the AI user this primitive ran under (for cost
    /// attribution + per-AI-user budget tracking).
    pub ai_user_identity: Identity,
    /// Marked `true` when an upstream input changes; UI shows a "stale"
    /// badge. Manual recompute clears by inserting a fresh row.
    pub is_stale: bool,
}

// ============================================================
// AI Evaluation Reducers (Phase B primitives)
// ============================================================

/// Persist a fresh evaluation result and (atomically) update the
/// `PagePropertyValue` on the row to point at it. Workers call this from
/// the `ai_primitive` task handler; the worker is responsible for output
/// schema validation before invocation.
#[reducer]
pub fn record_ai_evaluation(
    ctx: &ReducerContext,
    property_definition_id: u64,
    page_id: u64,
    input_hash: String,
    primitive: AiPrimitive,
    model: String,
    prompt_version: u32,
    output: String,
    input_tokens: u32,
    output_tokens: u32,
    cost_microcents: u64,
    wall_clock_ms: u32,
    ai_user_identity: Identity,
) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    ctx.db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("PropertyDefinition not found")?;

    // Mark any prior evaluation rows for this (property, page) stale.
    let prior: Vec<AiEvaluation> = ctx
        .db
        .ai_evaluation()
        .property_definition_id()
        .filter(&property_definition_id)
        .filter(|r| r.page_id == page_id && !r.is_stale)
        .collect();
    for row in prior {
        ctx.db
            .ai_evaluation()
            .id()
            .update(AiEvaluation { is_stale: true, ..row });
    }

    let row = ctx.db.ai_evaluation().insert(AiEvaluation {
        id: next_ai_evaluation_id(ctx),
        property_definition_id,
        page_id,
        input_hash,
        primitive,
        model,
        prompt_version,
        output: output.clone(),
        input_tokens,
        output_tokens,
        cost_microcents,
        wall_clock_ms,
        created_at: ctx.timestamp,
        ai_user_identity,
        is_stale: false,
    });

    set_property_value_inner(
        ctx,
        page_id,
        property_definition_id,
        PropertyValue::Ai(AiPropertyValue {
            output,
            evaluation_id: row.id,
            is_stale: false,
        }),
    )
}

/// Internal upsert used by both the human-driven `set_property_value` and
/// the AI-driven `record_ai_evaluation`. Skips the access guard because
/// callers already enforce it (and AI evaluations may run under a service
/// identity).
fn set_property_value_inner(
    ctx: &ReducerContext,
    page_id: u64,
    property_definition_id: u64,
    value: PropertyValue,
) -> Result<(), String> {
    let stale_history: Vec<PagePropertyValueHistory> = ctx
        .db
        .page_property_value_history()
        .page_id()
        .filter(&page_id)
        .filter(|h| h.property_definition_id == property_definition_id && h.is_current)
        .collect();
    for hist in stale_history {
        ctx.db
            .page_property_value_history()
            .id()
            .update(PagePropertyValueHistory {
                is_current: false,
                ..hist
            });
    }
    ctx.db
        .page_property_value_history()
        .insert(PagePropertyValueHistory {
            id: next_page_property_value_history_id(ctx),
            page_id,
            property_definition_id,
            value: value.clone(),
            is_current: true,
            changed_at: ctx.timestamp,
            changed_by: ActorType::Agent("ai-primitive".to_string()),
        });
    let existing: Option<PagePropertyValue> = ctx
        .db
        .page_property_value()
        .page_id()
        .filter(&page_id)
        .find(|v| v.property_definition_id == property_definition_id);
    match existing {
        Some(existing) => {
            ctx.db
                .page_property_value()
                .id()
                .update(PagePropertyValue { value, ..existing });
        }
        None => {
            ctx.db.page_property_value().insert(PagePropertyValue {
                id: next_page_property_value_id(ctx),
                page_id,
                property_definition_id,
                value,
            });
        }
    }
    Ok(())
}

/// Mark every `AiEvaluation` for `(property_definition_id, page_id)` as
/// stale. Called when an upstream input column changes (the worker
/// scheduler reads this to know what to recompute under
/// `InvalidationPolicy::OnInputChange`).
#[reducer]
pub fn invalidate_ai_evaluations_for_row(
    ctx: &ReducerContext,
    property_definition_id: u64,
    page_id: u64,
) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    let live: Vec<AiEvaluation> = ctx
        .db
        .ai_evaluation()
        .property_definition_id()
        .filter(&property_definition_id)
        .filter(|r| r.page_id == page_id && !r.is_stale)
        .collect();
    for row in live {
        ctx.db
            .ai_evaluation()
            .id()
            .update(AiEvaluation { is_stale: true, ..row });
    }
    Ok(())
}

