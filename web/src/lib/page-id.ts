const MAX_PAGE_ID = (1n << 64n) - 1n;

/** Route parameters must be bounded decimal u64 IDs, matching the page table. */
export function parsePageId(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 20 || /[^0-9]/.test(value)) return null;
  const id = BigInt(value);
  return id <= MAX_PAGE_ID ? id : null;
}
