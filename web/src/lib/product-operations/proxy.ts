/** Server-only transport. Session/bearer acquisition and workspace membership belong to the host. */
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
function error(status: number, code: string): Response { return Response.json({ ok: false, error: code }, { status, headers }); }
async function boundedJson(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<unknown> {
  if (!body) throw new Error('missing_body');
  const reader = body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength; if (size > maximum) throw new Error('body_too_large'); parts.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function isSameOriginMutation(request: Request): boolean {
  return request.headers.get('origin') === new URL(request.url).origin
    && !['cross-site', 'none'].includes(request.headers.get('sec-fetch-site') ?? '');
}

export async function forwardProductOperations(options: {
  request: Request; endpoint: string | undefined; bearer: string; workspaceSlug: string; fetch?: typeof fetch;
}): Promise<Response> {
  if (!options.endpoint) return error(503, 'operations_not_configured');
  let target: URL;
  try {
    const origin = new URL(options.endpoint);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('invalid_endpoint');
    target = new URL('/v1/product-operations', origin);
  } catch { return error(503, 'operations_not_configured'); }
  if (!options.bearer || /[\r\n]/.test(options.bearer)) return error(401, 'unauthorized');
  if (options.request.method !== 'POST') return error(405, 'method_not_allowed');
  if (!/^application\/json(?:\s*;|$)/i.test(options.request.headers.get('content-type') ?? '')) return error(415, 'json_required');
  let value: Record<string, unknown>;
  try {
    const input = await boundedJson(options.request.body, 1_048_576);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_request');
    value = input as Record<string, unknown>;
    if (['actor', 'scope', 'workspaceId', 'workspaceSlug', 'schemaVersion'].some(key => key in value)) throw new Error('invalid_request');
    if (typeof value.productId !== 'string' || !value.productId.trim() || value.productId.length > 128) throw new Error('invalid_request');
  } catch { return error(400, 'invalid_request'); }
  try {
    const response = await (options.fetch ?? fetch)(target, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${options.bearer}` },
      body: JSON.stringify({ ...value, schemaVersion: 1, workspaceSlug: options.workspaceSlug }),
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    const result = await boundedJson(response.body, 8_388_608);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid_response');
    if (response.ok && 'ok' in result && result.ok === true && 'result' in result) return Response.json(result, { headers });
    const code = 'error' in result && typeof result.error === 'string' && /^[a-z_]{1,80}$/.test(result.error) ? result.error : 'operations_unavailable';
    return error([400, 401, 403, 404, 409, 413, 503].includes(response.status) ? response.status : 502, code);
  } catch { return error(502, 'receipt_unconfirmed'); }
}

export interface OperationsProductChoice {
  productId: string; label: string; controllerActorId?: string;
  sources: { resource: string; label: string }[];
}
/** Display configuration cannot grant authority; service configuration and live grants still govern. */
export function operationsProducts(raw: string | undefined, workspaceSlug: string): OperationsProductChoice[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 128) return [];
    const rows = parsed.filter((item: unknown) => !!item && typeof item === 'object' && 'workspaceSlug' in item && item.workspaceSlug === workspaceSlug);
    const choices: OperationsProductChoice[] = [];
    for (const row of rows) {
      if (typeof row.productId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.productId)
        || typeof row.label !== 'string' || !row.label.trim() || row.label.length > 256 || !Array.isArray(row.sources) || row.sources.length > 128
        || (row.controllerActorId !== undefined && (typeof row.controllerActorId !== 'string' || !/^agent:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[a-f0-9]{64}$/.test(row.controllerActorId)))) return [];
      const sources = row.sources.map((source: unknown) => {
        if (!source || typeof source !== 'object' || !('resource' in source) || typeof source.resource !== 'string' || !source.resource.trim() || source.resource.length > 256
          || !('label' in source) || typeof source.label !== 'string' || !source.label.trim() || source.label.length > 256) throw new Error('invalid_source');
        return { resource: source.resource, label: source.label };
      });
      if (new Set(sources.map((source: { resource: string }) => source.resource)).size !== sources.length || choices.some(choice => choice.productId === row.productId)) return [];
      choices.push({ productId: row.productId, label: row.label, sources, ...(row.controllerActorId ? { controllerActorId: row.controllerActorId } : {}) });
    }
    return choices;
  } catch { return []; }
}
