import { describe, expect, test } from "vitest";
import { dateOnlyKey, formatDateOnly } from "./date-only";

describe("formatDateOnly", () => {
  test("renders UTC-midnight storage as the same calendar date (#389)", () => {
    const timestamp = Date.UTC(2026, 6, 14);
    expect(formatDateOnly(timestamp, "en-US")).toBe("7/14/2026");
  });

  test("keeps the date stable for timestamps later on the same UTC day", () => {
    const timestamp = Date.UTC(2026, 6, 14, 23, 59);
    expect(formatDateOnly(timestamp, "en-US")).toBe("7/14/2026");
    expect(dateOnlyKey(timestamp)).toBe("2026-07-14");
  });
});
