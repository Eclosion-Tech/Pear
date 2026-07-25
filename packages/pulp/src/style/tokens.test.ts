/**
 * `style_v1` token parsing — the enforcement point, not a formality.
 *
 * Prop schemas are client-validated only, so an agent writing over MCP can put
 * arbitrary JSON in props today. These tests assert the properties the ADR's D1
 * and D5 actually depend on: nothing outside the closed set survives parsing,
 * and no caller-supplied value can reach a renderer as-is.
 */

import { describe, expect, test, vi } from "vitest";
import { SPACE_TOKENS, isEmptyStyle, parseStyleTokens, readStyleTokens } from "./tokens";

describe("accepted values", () => {
  test("every declared space token round-trips on every space key", () => {
    for (const token of SPACE_TOKENS) {
      expect(parseStyleTokens({ padding: token })).toEqual({ padding: token });
      expect(parseStyleTokens({ paddingX: token })).toEqual({ paddingX: token });
      expect(parseStyleTokens({ paddingY: token })).toEqual({ paddingY: token });
      expect(parseStyleTokens({ gap: token })).toEqual({ gap: token });
      expect(parseStyleTokens({ indent: token })).toEqual({ indent: token });
    }
  });

  test("keys combine", () => {
    expect(parseStyleTokens({ indent: "md", gap: "sm" })).toEqual({ indent: "md", gap: "sm" });
  });
});

describe("the allowlist (D5) — hostile and merely wrong input", () => {
  test("an unknown token value is dropped, not passed through", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseStyleTokens({ indent: "enormous" })).toEqual({});
    warn.mockRestore();
  });

  test("a raw CSS value is dropped — this is the whole fence", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseStyleTokens({ padding: "9999px" })).toEqual({});
    expect(parseStyleTokens({ indent: "calc(100% - 4px)" })).toEqual({});
    expect(parseStyleTokens({ gap: "1rem;background:url(https://evil.example)" })).toEqual({});
    warn.mockRestore();
  });

  test("a Tailwind class is dropped — classes are not a storage format (D4)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseStyleTokens({ indent: "pl-4" })).toEqual({});
    warn.mockRestore();
  });

  test("unknown keys are ignored entirely", () => {
    expect(parseStyleTokens({ className: "p-4", onClick: "alert(1)" })).toEqual({});
  });

  test("valid keys survive alongside invalid ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseStyleTokens({ indent: "md", padding: "13px", className: "x" })).toEqual({
      indent: "md",
    });
    warn.mockRestore();
  });

  test("non-string values are rejected", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of [4, null, true, {}, ["md"]]) {
      expect(parseStyleTokens({ indent: bad })).toEqual({});
    }
    warn.mockRestore();
  });

  test("prototype-pollution shaped input does not leak through", () => {
    const parsed = parseStyleTokens(JSON.parse('{"__proto__":{"indent":"md"},"indent":"sm"}'));
    expect(parsed).toEqual({ indent: "sm" });
    expect(({} as Record<string, unknown>).indent).toBeUndefined();
  });
});

describe("malformed containers", () => {
  test("non-objects yield an empty style rather than throwing", () => {
    for (const bad of [null, undefined, 4, "md", [], true]) {
      expect(parseStyleTokens(bad)).toEqual({});
    }
  });

  test("readStyleTokens survives malformed props JSON", () => {
    expect(readStyleTokens("{not json")).toEqual({});
    expect(readStyleTokens("")).toEqual({});
    expect(readStyleTokens("null")).toEqual({});
  });

  test("readStyleTokens pulls the nested style key", () => {
    expect(readStyleTokens(JSON.stringify({ layout: "stack", style: { indent: "lg" } }))).toEqual({
      indent: "lg",
    });
  });

  test("props with no style key yield empty", () => {
    expect(readStyleTokens(JSON.stringify({ layout: "stack" }))).toEqual({});
    expect(isEmptyStyle(readStyleTokens('{"layout":"stack"}'))).toBe(true);
  });
});
