import type { McpToolEntry } from './types';
import { PRODUCT_OPERATIONS_TOOLS, validProductOperationsInput, type ProductOperationsAction } from './product-operations-contract';
import { productOperationsPayloadSchema } from './product-operations-schema';

export function productOperationsTools(): McpToolEntry[] {
  const id = { type: 'string', minLength: 1, maxLength: 256 } as const;
  const common = { productId: id, initiativeId: id, commandId: id, expectedRevision: { type: 'integer', minimum: 0 } };
  const entry = (action: ProductOperationsAction, properties: NonNullable<McpToolEntry['inputSchema']['properties']>, required: string[], description: string): McpToolEntry => ({
    name: PRODUCT_OPERATIONS_TOOLS[action], description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    async execute(ctx, input) {
      if (!validProductOperationsInput(action, input)) return JSON.stringify({ ok: false, error: 'invalid_product_operations_request' });
      if (!ctx.productOperations) return JSON.stringify({ ok: false, error: 'product_operations_unavailable' });
      try { return JSON.stringify(await ctx.productOperations.invoke(action, input)); }
      catch { return JSON.stringify({ ok: false, error: action === 'read' ? 'product_operations_unavailable' : 'product_operations_outcome_unknown_no_retry',
        ...(action === 'read' ? {} : { commandId: input.commandId, initiativeId: input.initiativeId }), ...(action === 'dispatch' ? { operationId: input.commandId } : {}) }); }
    },
  });
  return [
    entry('read', { productId: id, action: { type: 'string', enum: ['whoami', 'list', 'get', 'plan', 'history', 'execution_status'] }, initiativeId: id, operationId: id, limit: { type: 'integer', minimum: 1, maximum: 50 }, afterId: id }, ['productId', 'action'],
      'Read product initiative state, next actions, command history or a delegated operation. whoami returns this OAuth identity; list requires limit (1–50) and optional afterId for participant-filtered summaries. Other actions require initiativeId; execution_status also requires operationId. Never starts work.'),
    entry('contribute', { ...common, payload: productOperationsPayloadSchema }, Object.keys(common).concat('payload'),
      'Contribute evidence, request a human decision, propose/revise assignments, define metrics, record observations or evaluate supported outcomes under the initiative domain contracts. Read current state first. Requires exact expectedRevision and stable commandId. Cannot create initiatives, resolve human decisions, change delegation, report worker outcomes or stop work. Bounded to 64 KiB. Never automatically retries; inspect history on unknown outcome.'),
    entry('dispatch', { ...common, assignmentId: id, executionId: id }, Object.keys(common).concat('assignmentId', 'executionId'),
      'Queue one existing assignment under its human-approved scope, decisions and resource limits. Requires read, write and execute scopes; server selects a registered adapter and attributes it to this OAuth identity. Stable commandId is also operationId. A queued receipt is not execution success. On uncertainty inspect execution_status; never submit a new identity as a retry.'),
  ];
}
