/** Browser transport never retries a mutation. Callers retain its exact request until reconciled. */
export async function operationsRequest<T>(endpoint: string, request: Record<string, unknown>, options: { fetch?: typeof fetch; bearer?: string; signal?: AbortSignal } = {}): Promise<T> {
  if (!endpoint.startsWith('/') || endpoint.startsWith('//') || /[?#\\]/.test(endpoint)) throw new Error('Invalid operations endpoint.');
  const response = await (options.fetch ?? fetch)(endpoint, { method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}) },
    body: JSON.stringify(request), signal: options.signal ?? AbortSignal.timeout(25_000) });
  const result = await response.json() as { ok?: boolean; result?: T; error?: string };
  if (!response.ok || result.ok !== true) {
    const messages: Record<string, string> = {
      unauthorized: 'Your session has expired. Sign in again, then refresh.', forbidden: 'Your current access does not permit this action.',
      conflict: 'This initiative changed. Refresh and review it before submitting a new action.',
      operations_not_configured: 'Product operations is not connected for this workspace yet.',
      receipt_unconfirmed: 'The result is not confirmed. Refresh to inspect the saved state, or explicitly check the same submission.',
    };
    throw new Error(messages[result.error ?? ''] ?? 'The operation could not be confirmed. Refresh to inspect the saved state.');
  }
  return result.result as T;
}
export interface InitiativeCard {
  id: string; revision: number; status: string; purpose: string; audience: string; intendedOutcome: string; pendingDecisions: number; updatedAt: string;
}
export interface InitiativeView {
  id: string; revision: number; ownerId: string; status: string;
  context: { purpose: string; audience: string; problem: string; intendedOutcome: string; constraints: string[] };
  successCriteria: string[];
  delegation: { resources: string[]; capabilities: string[]; maxExecutions: number; maxUnits: number; expiresAt: string };
  decisions: { id: string; category: string; question: string; recommendedOptionId: string; evidenceIds: string[];
    options: { id: string; description: string }[]; resolution?: { optionId: string; rationale: string } }[];
  assignments: { id: string; objective: string; status: string; resource: string; acceptanceCriteria: string[] }[];
  executions: { id: string; assignmentId: string; status: string; explanation?: string; evidenceIds: string[] }[];
  evidence: { id: string; kind: string; summary: string; source: { uri: string; owner: string; version?: string }; capturedAt: string }[];
  observations: { id: string; metricId: string; value: number | null; sampleSize: number; windowStart: string; windowEnd: string }[];
  evaluations: { id: string; verdict: string; rationale: string }[];
}
export function safeEvidenceLink(uri: string): string | undefined {
  try { const url = new URL(uri); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; }
}
export function actionDescription(action: { type: string; reason?: string }): string {
  const labels: Record<string, string> = { investigate: 'Gather evidence and propose the next step', await_decision: 'Waiting for your decision',
    dispatch: 'Ready for the controller', await_execution: 'Work is in progress', reconcile_execution: 'An execution needs its result checked',
    review_failed_assignment: 'Review a failed assignment', revise_assignment: 'Revise work to follow the decision', review_delegation: 'Review delegated authority or capacity',
    begin_observation: 'Ready to observe the outcome', define_metric: 'Define the outcome measure', collect_evidence: 'Collect outcome evidence',
    await_evidence: 'Waiting for more evidence', wait_until: 'Waiting for the observation period', evaluate: 'Ready to evaluate the outcome' };
  return labels[action.type] ?? 'Review the next step';
}
