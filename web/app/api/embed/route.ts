import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
/** First model load can take ~30s+ while weights download. */
export const maxDuration = 120;

const MAX_CHARS = 8000;

type FeatureExtractor = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Promise<any>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import("@xenova/transformers");
      const pipe = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
        { quantized: true },
      );
      return pipe as FeatureExtractor;
    })();
  }
  return extractorPromise;
}

/**
 * POST { text: string } → { embedding: number[] } (384-dim, L2-normalized).
 * Used for semantic search and page indexing.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const extractor = await getExtractor();
    const sliced = text.slice(0, MAX_CHARS);
    const output = await extractor(sliced, { pooling: "mean", normalize: true });
    const raw = output?.data ?? output;
    const data =
      raw instanceof Float32Array
        ? raw
        : new Float32Array(raw as ArrayLike<number>);
    if (!data || data.length !== 384) {
      return NextResponse.json(
        { error: `unexpected embedding dimension: ${data?.length ?? 0}` },
        { status: 500 },
      );
    }
    return NextResponse.json({ embedding: Array.from(data) });
  } catch (err) {
    console.error("[api/embed]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "embed failed" },
      { status: 500 },
    );
  }
}
