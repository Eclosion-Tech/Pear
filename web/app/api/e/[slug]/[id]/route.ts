import { serveEndpointRequest } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string; id: string }>;
}

async function handle(request: Request, ctx: RouteContext): Promise<Response> {
  const { slug, id } = await ctx.params;
  return serveEndpointRequest({ request, slug, trailing: id });
}

export const GET = handle;
export const PATCH = handle;
export const DELETE = handle;
