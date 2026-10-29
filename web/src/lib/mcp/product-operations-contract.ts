/** Portable MCP boundary. The service remains authoritative for domain validation. */
export const PRODUCT_OPERATIONS_TOOLS = {
  read: 'product_operations_read', contribute: 'product_operations_contribute', dispatch: 'product_operations_dispatch',
} as const;
export type ProductOperationsAction = keyof typeof PRODUCT_OPERATIONS_TOOLS;
export const PRODUCT_OPERATIONS_COMMANDS = {
  record_evidence: 'evidence', request_decision: 'decision', propose_assignment: 'assignment', revise_assignment: 'assignment',
  define_metric: 'metric', begin_observation: 'evidenceIds', record_observation: 'observation', evaluate: 'evaluation',
} as const;
export interface ProductOperationsApi {
  invoke(action: ProductOperationsAction, input: Record<string, unknown>): Promise<unknown>;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function id(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= 256; }
function bounded(value: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 65_536;
  if (Array.isArray(value)) return value.length <= 256 && value.every(item => bounded(item, depth + 1));
  return object(value) && Object.keys(value).length <= 128 && Object.values(value).every(item => bounded(item, depth + 1));
}
export function validProductOperationsInput(action: ProductOperationsAction, input: unknown): input is Record<string, unknown> {
  if (!object(input) || !bounded(input) || !id(input.productId)) return false;
  try { if (new TextEncoder().encode(JSON.stringify(input)).length > 65_536) return false; } catch { return false; }
  if (action === 'read') {
    if (input.action === 'whoami') return exact(input, ['productId', 'action']);
    if (input.action === 'list') return exact(input, ['productId', 'action', 'limit', ...('afterId' in input ? ['afterId'] : [])])
      && Number.isSafeInteger(input.limit) && Number(input.limit) >= 1 && Number(input.limit) <= 50 && (!('afterId' in input) || id(input.afterId));
    if (!id(input.initiativeId)) return false;
    if (input.action === 'execution_status') return exact(input, ['productId', 'action', 'initiativeId', 'operationId']) && id(input.operationId);
    return ['get', 'plan', 'history'].includes(String(input.action)) && exact(input, ['productId', 'action', 'initiativeId']);
  }
  if (!id(input.initiativeId) || !id(input.commandId) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) return false;
  const base = ['productId', 'initiativeId', 'commandId', 'expectedRevision'];
  if (action === 'dispatch') return exact(input, [...base, 'assignmentId', 'executionId']) && id(input.assignmentId) && id(input.executionId);
  if (action !== 'contribute' || !exact(input, [...base, 'payload']) || !object(input.payload)) return false;
  const type = input.payload.type;
  if (typeof type !== 'string' || !Object.hasOwn(PRODUCT_OPERATIONS_COMMANDS, type)) return false;
  const field = PRODUCT_OPERATIONS_COMMANDS[type as keyof typeof PRODUCT_OPERATIONS_COMMANDS];
  if (!exact(input.payload, ['type', field])) return false;
  const value = input.payload[field];
  if (field === 'evidenceIds') return Array.isArray(value) && value.length > 0 && value.every(id);
  if (!object(value)) return false;
  // Reject server-owned attribution before forwarding; the service checks every semantic field.
  if (field === 'decision' && 'resolution' in value) return false;
  if (field === 'assignment' && 'status' in value) return false;
  if (field === 'evaluation' && ['actorId', 'evaluatedAt', 'evaluatedRevision'].some(key => key in value)) return false;
  if (field === 'evaluation' && value.verdict === 'not_worth_pursuing') return false;
  return true;
}
export function productOperationsScopes(action: ProductOperationsAction): string[] {
  return ['product-operations:read', ...(action === 'read' ? [] : ['product-operations:write']), ...(action === 'dispatch' ? ['product-operations:execute'] : [])];
}
/** Build only from validated input and host-derived workspace/worker identity. */
export function productOperationsRequest(action: ProductOperationsAction, input: Record<string, unknown>, workspaceSlug: string, workerId: string) {
  const base = { schemaVersion: 1, workspaceSlug, productId: input.productId };
  return action === 'read' ? { ...base, action: input.action, ...(input.initiativeId ? { initiativeId: input.initiativeId } : {}), ...(input.operationId ? { operationId: input.operationId } : {}), ...(input.action === 'list' ? { limit: input.limit, ...(input.afterId ? { afterId: input.afterId } : {}) } : {}) }
    : { ...base, action: 'apply', initiativeId: input.initiativeId, command: { id: input.commandId, expectedRevision: input.expectedRevision,
      payload: action === 'contribute' ? input.payload : { type: 'dispatch', assignmentId: input.assignmentId, executionId: input.executionId, workerId } } };
}
