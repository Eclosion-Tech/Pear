/**
 * Structural sensors scheduler.
 *
 * Periodically invokes the cheap deterministic sensor reducers
 * (`run_orphan_detector`, `run_relational_integrity_sensor`,
 * `run_schema_consistency_sensor`, `run_convention_sensor`) over the
 * relational substrate. Findings are upserted into
 * `structural_sensor_finding` and surfaced in the Inbox / Members tab.
 *
 * Implemented as a simple `setInterval` loop owned by the database worker
 * rather than a SpacetimeDB scheduled table because (a) the worker holds
 * an admin token already, (b) we want jitter and per-deployment cadence
 * tuning without a redeploy, and (c) the sensors are pure read-then-upsert
 * reducers that compose with the rest of the worker's reducer-call surface.
 *
 * Cadence defaults are intentionally infrequent — the substrate is small
 * and these are inexpensive, but they walk every page / property value
 * so we don't want to thrash the database. Override via env:
 *
 *   STRUCTURAL_SENSORS_INTERVAL_MS   default 15 minutes
 *   STRUCTURAL_SENSORS_INITIAL_DELAY default 30 seconds (after connect)
 *   STRUCTURAL_SENSORS_DISABLED      set to "1" to skip
 */

import type { DbConnection } from "./module_bindings/index.js";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 30 * 1000;

type SensorName =
  | "run_orphan_detector"
  | "run_relational_integrity_sensor"
  | "run_schema_consistency_sensor"
  | "run_convention_sensor"
  | "run_denied_tool_calls_sensor";

const SENSORS: SensorName[] = [
  "run_orphan_detector",
  "run_relational_integrity_sensor",
  "run_schema_consistency_sensor",
  "run_convention_sensor",
  "run_denied_tool_calls_sensor",
];

export interface StructuralSensorsOptions {
  intervalMs?: number;
  initialDelayMs?: number;
  /** Logging label, e.g. the database name. */
  label: string;
}

export class StructuralSensorsScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private running = false;

  constructor(
    private readonly conn: DbConnection,
    private readonly opts: StructuralSensorsOptions,
  ) {}

  start(): void {
    if (process.env.STRUCTURAL_SENSORS_DISABLED === "1") {
      console.log(
        `[sensors:${this.opts.label}] Disabled via STRUCTURAL_SENSORS_DISABLED`,
      );
      return;
    }

    const initial = this.opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    const interval = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS;

    console.log(
      `[sensors:${this.opts.label}] Scheduling structural sensors ` +
        `(initial=${initial}ms, interval=${interval}ms)`,
    );

    this.timer = setTimeout(() => {
      void this.runOnce();
      this.interval = setInterval(() => void this.runOnce(), interval);
    }, initial);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  async runOnce(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      for (const name of SENSORS) {
        if (this.stopped) break;
        await this.invoke(name);
      }
    } finally {
      this.running = false;
    }
  }

  private async invoke(name: SensorName): Promise<void> {
    const start = Date.now();
    try {
      const reducers = (this.conn as unknown as {
        reducers: Record<string, (() => Promise<void>) | undefined>;
      }).reducers;
      const accessor = toCamelCase(name);
      const fn = reducers[accessor];
      if (typeof fn !== "function") {
        console.warn(
          `[sensors:${this.opts.label}] Reducer accessor missing: ${accessor}`,
        );
        return;
      }
      await fn();
      console.log(
        `[sensors:${this.opts.label}] ${name} ok (${Date.now() - start}ms)`,
      );
    } catch (err) {
      console.warn(
        `[sensors:${this.opts.label}] ${name} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function toCamelCase(snake: string): string {
  return snake.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}
