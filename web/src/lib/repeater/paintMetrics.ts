/**
 * Delivery-to-paint instrumentation for the M3 back-out bar.
 *
 * The ADR's flag gate is quantitative, not qualitative: the repeater sidebar
 * ships only if p99 delivery-to-paint lands within 1.5× of the bespoke one on
 * the churn and deep-nesting scenarios, with no remount storms under sort or
 * filter churn. "Feels the same" is explicitly not sufficient on its own, so
 * both implementations record through this module and are compared on the same
 * clock.
 *
 * What one sample measures: the moment a row delivery is observed, through
 * React's render and commit, to the first frame the browser paints after it.
 * That is the number a user actually experiences — it deliberately includes
 * materialization, reconciliation, and layout rather than just the JS.
 *
 * Read the numbers from devtools:
 *
 *     __pearPaintMetrics.report()
 *     __pearPaintMetrics.reset()
 */

export type PaintSource = "bespoke-sidebar" | "repeater-sidebar";

export type PaintStats = {
  source: PaintSource;
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Mount/remount count — a proxy for the "no remount storms" clause. */
  mounts: number;
};

const MAX_SAMPLES = 2000;

/**
 * Minimum samples per side before a verdict is emitted.
 *
 * Only one sidebar renders at a time, so the two sides are necessarily
 * measured in *different sessions*. Without a floor, a single cold-start
 * sample from the losing side produces a wildly flattering ratio and a green
 * `withinBar` that means nothing.
 */
const MIN_SAMPLES_FOR_VERDICT = 20;

const STORAGE_KEY = "pear:paint-metrics";

type Persisted = Record<string, { samples: number[]; mounts: number }>;

const samples = new Map<PaintSource, number[]>();
const mounts = new Map<PaintSource, number>();

/**
 * Samples survive reloads.
 *
 * Flipping the flag requires a reload, and each session can only exercise one
 * implementation — so in-memory-only state could never accumulate both sides of
 * the comparison. Persisting is what makes the harness usable at all: run the
 * bespoke sidebar, reload into the repeater, and `report()` compares them.
 */
function load(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Persisted;
    for (const [source, entry] of Object.entries(parsed)) {
      if (Array.isArray(entry?.samples)) samples.set(source as PaintSource, entry.samples);
      if (typeof entry?.mounts === "number") mounts.set(source as PaintSource, entry.mounts);
    }
  } catch {
    // Corrupt or unavailable storage — start clean rather than throw on import.
  }
}

let saveQueued = false;
function save(): void {
  if (typeof window === "undefined" || saveQueued) return;
  saveQueued = true;
  // Batched: deliveries can arrive in bursts, and this must not become part of
  // what is being measured.
  setTimeout(() => {
    saveQueued = false;
    try {
      const out: Persisted = {};
      for (const [source, arr] of samples) {
        out[source] = { samples: arr, mounts: mounts.get(source) ?? 0 };
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {
      // Quota or private mode — metrics degrade to in-memory, which is fine.
    }
  }, 500);
}

function push(source: PaintSource, ms: number): void {
  let arr = samples.get(source);
  if (!arr) {
    arr = [];
    samples.set(source, arr);
  }
  arr.push(ms);
  // Ring-buffer semantics: a long dogfood session should report recent
  // behaviour, not be dominated by startup outliers.
  if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
  save();
}

load();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Record one delivery. Call at the moment new rows are observed; the returned
 * function must be invoked from a layout effect so the rAF lands on the frame
 * that actually paints this update.
 */
export function measureDelivery(source: PaintSource): () => void {
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  let done = false;
  return () => {
    if (done || typeof requestAnimationFrame === "undefined") return;
    done = true;
    requestAnimationFrame(() => {
      push(source, performance.now() - t0);
    });
  };
}

export function recordMount(source: PaintSource): void {
  mounts.set(source, (mounts.get(source) ?? 0) + 1);
  save();
}

export function statsFor(source: PaintSource): PaintStats {
  const sorted = (samples.get(source) ?? []).slice().sort((a, b) => a - b);
  return {
    source,
    samples: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    mounts: mounts.get(source) ?? 0,
  };
}

/**
 * Both implementations side by side, plus the ADR's pass/fail verdict.
 *
 * Verdict is only meaningful once both have samples from comparable use — the
 * bar is defined on the churn and deep-nesting scenarios, not on idle time, so
 * a green result from a quiet session proves nothing.
 */
export function report(): {
  bespoke: PaintStats;
  repeater: PaintStats;
  ratioP99: number | null;
  withinBar: boolean | null;
  verdict: string;
} {
  const bespoke = statsFor("bespoke-sidebar");
  const repeater = statsFor("repeater-sidebar");

  const short: PaintSource[] = [];
  if (bespoke.samples < MIN_SAMPLES_FOR_VERDICT) short.push("bespoke-sidebar");
  if (repeater.samples < MIN_SAMPLES_FOR_VERDICT) short.push("repeater-sidebar");

  if (short.length > 0 || bespoke.p99 <= 0) {
    return {
      bespoke,
      repeater,
      ratioP99: null,
      withinBar: null,
      verdict:
        `NOT COMPARABLE — need ≥${MIN_SAMPLES_FOR_VERDICT} samples per side, short on: ${short.join(", ") || "none"}. ` +
        "Exercise one sidebar under churn and deep nesting, flip pear:repeater-sidebar, reload, exercise the other. " +
        "Samples persist across reloads.",
    };
  }

  const ratioP99 = repeater.p99 / bespoke.p99;
  const withinBar = ratioP99 <= 1.5;
  return {
    bespoke,
    repeater,
    ratioP99,
    withinBar,
    verdict:
      `${withinBar ? "WITHIN" : "OUTSIDE"} the 1.5x p99 bar (${ratioP99.toFixed(2)}x). ` +
      "Mount counts are inflated in dev by StrictMode's double-invoke — judge remount storms in a production build.",
  };
}

export function reset(): void {
  samples.clear();
  mounts.clear();
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to do — in-memory state is already cleared.
    }
  }
}

// Exposed for devtools; the dogfood loop is a human reading numbers, not CI.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__pearPaintMetrics = {
    report,
    reset,
    statsFor,
  };
}
