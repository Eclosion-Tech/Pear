import { describe, expect, it } from "vitest";
import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it("formats each magnitude", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(48 * 1024)).toBe("48 KB");
    expect(formatBytes(2.3 * 1024 ** 2)).toBe("2.3 MB");
    expect(formatBytes(1.1 * 1024 ** 3)).toBe("1.1 GB");
  });

  it("accepts bigint", () => {
    expect(formatBytes(BigInt(3 * 1024 ** 2))).toBe("3.0 MB");
  });

  it("returns empty for missing or invalid input", () => {
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
  });
});
