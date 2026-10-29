/** Standalone WebCrypto protocol, shared by gateway transport and receiver interoperability tests. */
export const PRODUCT_OPERATIONS_RELAY_PATH = '/v1/product-operations/relay';
export function productOperationsRelayKey(secret: string): Uint8Array<ArrayBuffer> {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('product_operations_unavailable');
  return Uint8Array.from(secret.match(/../g)!.map(byte => parseInt(byte, 16)));
}
export async function signProductOperationsRelay(secret: string, timestamp: string, body: string): Promise<string> {
  if (!/^\d{13}$/.test(timestamp)) throw new Error('product_operations_unavailable');
  const imported = await crypto.subtle.importKey('raw', productOperationsRelayKey(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = new TextEncoder().encode(`pear-product-operations-relay-v1\nPOST\n${PRODUCT_OPERATIONS_RELAY_PATH}\n${timestamp}\n${body}`);
  const signature = await crypto.subtle.sign('HMAC', imported, message);
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}
