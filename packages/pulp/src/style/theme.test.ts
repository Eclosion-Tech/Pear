/**
 * `Theme` parsing (style_v1 S2).
 *
 * The background-image cases carry most of the weight: it is the one theme
 * value that references external bytes, so it is the one place an unbounded
 * value could sneak back in. D1 holds only if a storage key stays an opaque
 * object id and never a path or URL.
 */

import { describe, expect, test, vi } from "vitest";
import {
  DENSITY_TOKENS,
  FONT_TOKENS,
  GRADIENT_TOKENS,
  RADIUS_TOKENS,
  TONE_TOKENS,
  parseTheme,
  readTheme,
  resolveTheme,
  type Theme,
} from "./theme";

const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("versioning (D6)", () => {
  test("v is mandatory", () => {
    expect(parseTheme({ accent: "blue" })).toBeNull();
  });

  test("an unsupported version is refused rather than guessed at", () => {
    const warn = quiet();
    expect(parseTheme({ v: 2, accent: "blue" })).toBeNull();
    warn.mockRestore();
  });

  test("v:1 with nothing else is a valid empty theme", () => {
    expect(parseTheme({ v: 1 })).toEqual({ v: 1 });
  });
});

describe("closed sets", () => {
  test("every declared token round-trips", () => {
    for (const tone of TONE_TOKENS) {
      expect(parseTheme({ v: 1, accent: tone })).toEqual({ v: 1, accent: tone });
    }
    for (const font of FONT_TOKENS) {
      expect(parseTheme({ v: 1, font })).toEqual({ v: 1, font });
    }
    for (const density of DENSITY_TOKENS) {
      expect(parseTheme({ v: 1, density })).toEqual({ v: 1, density });
    }
    for (const radius of RADIUS_TOKENS) {
      expect(parseTheme({ v: 1, radius })).toEqual({ v: 1, radius });
    }
    for (const gradient of GRADIENT_TOKENS) {
      expect(parseTheme({ v: 1, background: { kind: "gradient", gradient } })).toEqual({
        v: 1,
        background: { kind: "gradient", gradient },
      });
    }
  });

  test("out-of-set values are dropped, not passed through", () => {
    expect(parseTheme({ v: 1, accent: "#ff00ff" })).toEqual({ v: 1 });
    expect(parseTheme({ v: 1, font: "Comic Sans MS" })).toEqual({ v: 1 });
    expect(parseTheme({ v: 1, background: { kind: "gradient", gradient: "rainbow" } })).toEqual({
      v: 1,
    });
    expect(parseTheme({ v: 1, background: { kind: "css", value: "red" } })).toEqual({ v: 1 });
  });
});

describe("background images — the one external reference (D1, D10)", () => {
  test("a plain object id is accepted and defaults fill in", () => {
    expect(
      parseTheme({ v: 1, background: { kind: "image", storageKey: "abc123" } }),
    ).toEqual({
      v: 1,
      background: { kind: "image", storageKey: "abc123", fit: "cover", opacity: 100 },
    });
  });

  test("a URL is refused — this is the exfiltration fence", () => {
    for (const bad of [
      "https://evil.example/x.png",
      "//evil.example/x.png",
      "data:image/png;base64,AAAA",
      "pages/12/x.png",
    ]) {
      expect(
        parseTheme({ v: 1, background: { kind: "image", storageKey: bad } }),
      ).toEqual({ v: 1 });
    }
  });

  test("an empty or non-string key is refused", () => {
    expect(parseTheme({ v: 1, background: { kind: "image", storageKey: "" } })).toEqual({ v: 1 });
    expect(parseTheme({ v: 1, background: { kind: "image", storageKey: 42 } })).toEqual({ v: 1 });
  });

  test("opacity is clamped rather than trusted", () => {
    const at = (opacity: unknown) => {
      const t = parseTheme({ v: 1, background: { kind: "image", storageKey: "k", opacity } });
      return t?.background?.kind === "image" ? t.background.opacity : null;
    };
    expect(at(150)).toBe(100);
    expect(at(-20)).toBe(0);
    expect(at(42.6)).toBe(43);
    expect(at("lots")).toBe(100);
    expect(at(Number.NaN)).toBe(100);
  });

  test("an unknown fit falls back to cover", () => {
    const t = parseTheme({ v: 1, background: { kind: "image", storageKey: "k", fit: "wat" } });
    expect(t?.background).toMatchObject({ fit: "cover" });
  });

  test("attachmentId rides along when present, for reference integrity", () => {
    const t = parseTheme({
      v: 1,
      background: { kind: "image", storageKey: "k", attachmentId: "att_1" },
    });
    expect(t?.background).toMatchObject({ storageKey: "k", attachmentId: "att_1" });
  });

  test("the key is named `storageKey` so the snapshot exporter collects it", () => {
    // packages/snapshot-core/src/v2.ts walks component_node.props recursively
    // for keys named exactly `storageKey`. Renaming this field would silently
    // break export portability, so the name is asserted here on purpose.
    const props = JSON.stringify({
      layout: "stack",
      theme: { v: 1, background: { kind: "image", storageKey: "obj-9" } },
    });
    expect(props).toContain('"storageKey":"obj-9"');
    expect(readTheme(props)?.background).toMatchObject({ storageKey: "obj-9" });
  });
});

describe("resolution (D9)", () => {
  const workspace: Theme = { v: 1, accent: "blue", font: "serif", density: "compact" };
  const page: Theme = { v: 1, accent: "pink" };

  test("page wins key-by-key, inheriting the rest", () => {
    expect(resolveTheme(page, workspace)).toEqual({
      v: 1,
      accent: "pink",
      font: "serif",
      density: "compact",
    });
  });

  test("either side alone resolves to itself", () => {
    expect(resolveTheme(page, null)).toEqual(page);
    expect(resolveTheme(null, workspace)).toEqual(workspace);
    expect(resolveTheme(null, null)).toBeNull();
  });
});

describe("malformed input", () => {
  test("non-objects and bad JSON yield null rather than throwing", () => {
    for (const bad of [null, undefined, 4, "theme", [], true]) {
      expect(parseTheme(bad)).toBeNull();
    }
    expect(readTheme("{not json")).toBeNull();
    expect(readTheme("")).toBeNull();
  });

  test("props without a theme key yield null", () => {
    expect(readTheme(JSON.stringify({ layout: "stack" }))).toBeNull();
  });
});
