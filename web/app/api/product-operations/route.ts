import { forwardProductOperations, isSameOriginMutation } from '@/src/lib/product-operations/proxy';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!isSameOriginMutation(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403, headers });
  const workspaceSlug = process.env.PRODUCT_OPERATIONS_WORKSPACE_SLUG;
  const endpoint = process.env.PRODUCT_OPERATIONS_SERVICE_URL;
  if (!endpoint || !workspaceSlug || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(workspaceSlug)) return Response.json({ ok: false, error: 'operations_not_configured' }, { status: 503, headers });
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401, headers });
  return forwardProductOperations({ request, endpoint, bearer: authorization.slice(7), workspaceSlug });
}
