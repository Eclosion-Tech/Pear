import { mobileInstanceConfig } from '@/src/lib/mobile-instance';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  try {
    return Response.json(mobileInstanceConfig(new URL(request.url).origin, process.env), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Mobile connection configuration is unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
