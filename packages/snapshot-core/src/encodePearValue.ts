function uint8ToBase64(u8: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(u8).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Lossless JSON-friendly encoding for SpacetimeDB row values
 * (bigint, bytes, Identity, Timestamp, TimeDuration).
 *
 * ScheduleAt columns materialize client-side as the tagged sum
 * `{ tag: "Interval", value: TimeDuration } | { tag: "Time", value: Timestamp }`;
 * the TimeDuration and Timestamp cases below make those encode to exactly the
 * shape the v2 import reducers expect:
 * `{ tag: "Interval", value: { __pear: "bigint", v } }` /
 * `{ tag: "Time", value: { __pear: "timestamp", v } }`.
 */
export function encodePearValue(v: unknown): unknown {
  if (v == null) return v;
  const t = typeof v;
  if (t === "bigint") return { __pear: "bigint", v: v.toString() };
  if (t === "number" || t === "boolean" || t === "string") return v;
  if (v instanceof Uint8Array) return { __pear: "bytes", v: uint8ToBase64(v) };
  if (Array.isArray(v)) return v.map(encodePearValue);
  if (t === "object") {
    const o = v as Record<string, unknown>;
    if (typeof (o as { toHexString?: () => string }).toHexString === "function") {
      return { __pear: "identity", v: (o as { toHexString: () => string }).toHexString() };
    }
    if (
      "microsSinceUnixEpoch" in o &&
      typeof (o as { microsSinceUnixEpoch: unknown }).microsSinceUnixEpoch === "bigint"
    ) {
      return {
        __pear: "timestamp",
        v: (o as { microsSinceUnixEpoch: bigint }).microsSinceUnixEpoch.toString(),
      };
    }
    // SDK TimeDuration (e.g. the Interval variant of a ScheduleAt column):
    // encode its micros as a tagged bigint. Detected via the SDK's unambiguous
    // own field name rather than the public `micros` getter, which could
    // collide with an ordinary row field.
    if (
      "__time_duration_micros__" in o &&
      typeof (o as { __time_duration_micros__: unknown }).__time_duration_micros__ === "bigint"
    ) {
      return {
        __pear: "bigint",
        v: (o as { __time_duration_micros__: bigint }).__time_duration_micros__.toString(),
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      out[k] = encodePearValue(val);
    }
    return out;
  }
  return v;
}
