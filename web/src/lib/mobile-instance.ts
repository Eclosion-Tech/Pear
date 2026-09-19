/** Public connection metadata; authentication still happens in SpacetimeDB. */
export function mobileInstanceConfig(origin: string, env: Record<string, string | undefined>) {
  const issuer = env.NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY?.trim();
  const webClient = env.NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID?.trim();
  const nativeClient = env.PEAR_MOBILE_OIDC_CLIENT_ID?.trim();
  let auth: { mode: 'native' } | { mode: 'oidc'; issuer: string; clientId: string; scopes: string[] } = { mode: 'native' };
  if (issuer || webClient || nativeClient) {
    if (!issuer || !webClient || !nativeClient) throw new Error('Configure PEAR_MOBILE_OIDC_CLIENT_ID for this OIDC instance.');
    const provider = new URL(issuer);
    if (provider.protocol !== 'https:' || provider.username || provider.password || provider.search || provider.hash) throw new Error('Mobile OIDC requires an HTTPS issuer.');
    auth = { mode: 'oidc', issuer, clientId: nativeClient, scopes: (env.PEAR_MOBILE_OIDC_SCOPES || 'openid profile email').split(/\s+/).filter(Boolean) };
  }
  const target = new URL(env.NEXT_PUBLIC_SPACETIMEDB_URI?.trim() || origin);
  if (target.protocol === 'https:') target.protocol = 'wss:';
  if (target.protocol !== 'wss:' || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error('Mobile requires a publicly reachable WSS SpacetimeDB address.');
  return { version: 1, name: env.PEAR_INSTANCE_NAME?.trim() || 'Pear', uri: target.origin, databaseName: env.NEXT_PUBLIC_SPACETIMEDB_DB_NAME?.trim() || 'pear-dev', auth };
}
