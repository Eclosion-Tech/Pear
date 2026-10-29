import { productOperationsRequest, productOperationsScopes, validProductOperationsInput, type ProductOperationsAction, type ProductOperationsApi } from './product-operations-contract';
import { PRODUCT_OPERATIONS_RELAY_PATH, productOperationsRelayKey, signProductOperationsRelay } from './product-operations-signature';
export { PRODUCT_OPERATIONS_RELAY_PATH, signProductOperationsRelay } from './product-operations-signature';

export interface ProductOperationsRelayCaller {
  grantId: string; principalId: string; aiUserId: string; clientId: string;
  tokenScopes: string[]; accessExpiresAtMs: number;
}
export interface ProductOperationsRelayOptions {
  /** Operator configuration only. Never accept endpoint/secret from tool input. */
  serviceUrl?: string; relaySecret?: string;
  workspaceSlug: string;
  /** Host supplies a verified OAuth identity; legacy worker tokens cannot construct this capability. */
  caller: ProductOperationsRelayCaller;
  fetch?: typeof fetch; clock?: () => number;
}
async function boundedResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('missing response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 8_388_608) throw new Error('response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid response');
  return parsed as Record<string, unknown>;
}
function unknownOutcome(action: ProductOperationsAction, input: Record<string, unknown>) {
  return action === 'read' ? { ok: false, error: 'product_operations_unavailable' } : {
    ok: false, error: 'product_operations_outcome_unknown_no_retry', commandId: input.commandId, initiativeId: input.initiativeId,
    ...(action === 'dispatch' ? { operationId: input.commandId } : {}),
    nextStep: 'Inspect current initiative/history and execution status before considering an exact replay with the original command identity and terms.',
  };
}

/** No token passthrough, automatic retries, actor overrides, or inference fallback. */
export function createProductOperationsRelay(options: ProductOperationsRelayOptions): ProductOperationsApi | undefined {
  if (!options.serviceUrl || !options.relaySecret) return undefined;
  const url = new URL(options.serviceUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('product_operations_unavailable');
  productOperationsRelayKey(options.relaySecret);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(options.workspaceSlug)) throw new Error('product_operations_unavailable');
  const caller = structuredClone(options.caller), workspaceSlug = options.workspaceSlug, secret = options.relaySecret;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(caller.grantId) || !/^[a-f0-9]{64}$/.test(caller.principalId)
    || !/^[1-9]\d{0,18}$/.test(caller.aiUserId) || BigInt(caller.aiUserId) > 9223372036854775807n
    || typeof caller.clientId !== 'string' || !caller.clientId.trim() || caller.clientId.length > 2048
    || !Array.isArray(caller.tokenScopes) || caller.tokenScopes.length > 64 || caller.tokenScopes.some(scope => typeof scope !== 'string' || !scope || scope.length > 128)
    || !Number.isSafeInteger(caller.accessExpiresAtMs)) throw new Error('product_operations_unavailable');
  const clock = options.clock ?? Date.now, fetcher = options.fetch ?? fetch;
  return { async invoke(action, input) {
    if (!validProductOperationsInput(action, input)) return { ok: false, error: 'invalid_product_operations_request' };
    if (caller.accessExpiresAtMs <= clock()) return { ok: false, error: 'unauthorized' };
    if (!productOperationsScopes(action).every(scope => caller.tokenScopes.includes(scope))) return { ok: false, error: 'forbidden' };
    const request = productOperationsRequest(action, input, workspaceSlug, `agent:${caller.grantId}:${caller.principalId}`);
    const body = JSON.stringify({ caller, request }), timestamp = String(clock());
    const signature = await signProductOperationsRelay(secret, timestamp, body);
    if (caller.accessExpiresAtMs <= clock()) return { ok: false, error: 'unauthorized' };
    try {
      const response = await fetcher(new URL(PRODUCT_OPERATIONS_RELAY_PATH, url), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Pear-Product-Operations-Time': timestamp, 'X-Pear-Product-Operations-Signature': signature }, body });
      const result = await boundedResponse(response);
      if (response.ok && result.ok === true && Object.hasOwn(result, 'result')) return { ok: true, result: result.result };
      // The receiver reauthorizes after async dispatch. A 401/403 can therefore follow a commit.
      if (action !== 'read' && [401, 403].includes(response.status)) return { ...unknownOutcome(action, input), status: response.status };
      if (response.status >= 400 && response.status < 500 && result.ok === false && typeof result.error === 'string' && /^[a-z_]{1,80}$/.test(result.error)) return { ok: false, error: result.error, status: response.status };
      return unknownOutcome(action, input);
    } catch { return unknownOutcome(action, input); }
  } };
}
