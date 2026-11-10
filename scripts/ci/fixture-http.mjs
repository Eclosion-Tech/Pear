export function safeUrl(value, name) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error(`${name}: expected HTTPS URL without credentials, query, or fragment`);
  }
  return url;
}

export async function requestJson(url, options = {}, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch {
    // Transport exceptions may embed URLs or bearer values. Never log them.
    throw new Error('Release probe network request failed');
  }
  if (!response.ok) throw new Error(`Release probe HTTP ${response.status}`);
  try { return await response.json(); } catch { throw new Error('Release probe returned invalid JSON'); }
}
