import { serveEndpointRequest } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const { slug } = await ctx.params;
  return serveEndpointRequest({ request, slug, trailing: "_schema" });
}
