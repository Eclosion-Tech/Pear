/** Server-to-server authentication only; the browser/Pi never receives this key. */
export const ANSWER_RELAY_PATH = "/v1/answers";
export function relayKey(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error("answer_relay_unavailable");
  return Uint8Array.from(value.match(/../g)!.map((x) => parseInt(x, 16)));
}
export async function relaySignature(
  key: string,
  timestamp: string,
  body: string,
): Promise<string> {
  if (!/^\d{13}$/.test(timestamp)) throw new Error("invalid_answer_relay");
  const k = await crypto.subtle.importKey(
    "raw",
    relayKey(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    k,
    new TextEncoder().encode(`pear-answer-relay-v1\n${timestamp}\n${body}`),
  );
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function verifyRelay(
  key: string,
  timestamp: string,
  body: string,
  signature: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 30_000 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false;
  const k = await crypto.subtle.importKey(
    "raw",
    relayKey(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    k,
    Uint8Array.from(signature.match(/../g)!.map((x) => parseInt(x, 16))),
    new TextEncoder().encode(`pear-answer-relay-v1\n${timestamp}\n${body}`),
  );
}
export async function boundedJson(
  response: Response,
  max = 65_536,
): Promise<any> {
  if (!response.body) throw new Error("answer_transport_unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error("answer_response_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
