import type { PageRow } from "@/src/hooks/usePages";


/** Extract 384-dim embedding from a Page row, if present and valid. */
export function getPageEmbeddingVector(page: PageRow): number[] | null {
  const e = page.embedding;
  if (e == null) return null;
  try {
    let raw: unknown = e;
    if (typeof raw === "object" && raw !== null && "tag" in raw) {
      const o = raw as { tag: string; value?: unknown };
      if (o.tag === "None") return null;
      if (o.tag === "Some" && o.value !== undefined) raw = o.value;
    }
    const arr = Array.isArray(raw) ? raw : Array.from(raw as Iterable<number>);
    return arr.length === 384 ? arr.map((x) => Number(x)) : null;
  } catch {
    return null;
  }
}

/** Cosine similarity for normalized embedding vectors (same length). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
