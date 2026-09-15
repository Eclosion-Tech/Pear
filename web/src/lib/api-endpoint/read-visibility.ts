/**
 * STDB 2.0.3 materializes a caller-scoped view when it is directly queried or
 * subscribed. An HTTP-only caller's first RLS-protected read must evaluate the
 * corresponding permission view first. Subsequent dependency changes revoke
 * access even without an active WebSocket subscription.
 *
 * Evaluate once per token-bound transport. The host maintains dependencies
 * after evaluation. COUNT keeps the response small for large workspaces.
 */
export function readVisibilityViews(query: string): string[] {
    const projections: Array<[
        string,
        RegExp
    ]> = [
        ["readable_pages", /\b(?:page|page_content|page_yjs_state|attachment|page_snapshot|page_access_rule|block_access_rule|page_property_value|page_property_value_history|database_schema|database_view|component_node|ai_user_memory|database_row_marker|ai_evaluation)\b/i],
        ["readable_components", /\bcomponent_yjs_state\b/i],
        ["readable_schemas", /\bproperty_definition\b/i],
        ["readable_conversations", /\b(?:conversation|conversation_message|conversation_participant|conversation_attachment|page_access_request)\b/i],
        ["readable_jobs", /\b(?:orcha_job|orcha_task|orcha_shared_context)\b/i],
        ["readable_automations", /\b(?:automation_rule|automation_action|automation_condition|automation_capability)\b/i],
        ["readable_automation_events", /\b(?:automation_event_queue|automation_run_log)\b/i],
        ["readable_review_snapshots", /\breview_annotation\b/i],
    ];
    return projections.filter(([, pattern]) => pattern.test(query)).map(([view]) => view);
}
