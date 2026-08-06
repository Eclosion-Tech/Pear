import { describe, expect, it } from "vitest";
import {
  normalizeGeneratedAutomationId,
  resolveGeneratedUiInput,
} from "./generatedUiActions";

describe("resolveGeneratedUiInput", () => {
  const fields = new Map([
    ["ask_id", { value: "42", required: true }],
    ["note", { value: "", required: false }],
  ]);

  it("resolves form references and preserves scalar literals", () => {
    expect(
      resolveGeneratedUiInput(
        {
          ask_id: "$form.ask_id",
          note: "$form.note",
          decision: "accepted",
          notify: true,
          score: 2,
          owner: null,
        },
        fields,
      ),
    ).toEqual({
      ok: true,
      input: {
        ask_id: "42",
        note: "",
        decision: "accepted",
        notify: true,
        score: 2,
        owner: null,
      },
    });
  });

  it("fails closed for missing, unsupported, and non-scalar bindings", () => {
    expect(resolveGeneratedUiInput({ id: "$form.missing" }, fields).ok).toBe(false);
    expect(resolveGeneratedUiInput({ id: "$identity" }, fields).ok).toBe(false);
    expect(resolveGeneratedUiInput({ id: { nested: true } }, fields).ok).toBe(false);
  });

  it("enforces required referenced inputs", () => {
    const empty = new Map([["ask_id", { value: "  ", required: true }]]);
    expect(resolveGeneratedUiInput({ id: "$form.ask_id" }, empty)).toEqual({
      ok: false,
      error: "ask_id is required.",
    });
  });
});

describe("normalizeGeneratedAutomationId", () => {
  it("accepts positive safe IDs and rejects ambiguous numbers", () => {
    expect(normalizeGeneratedAutomationId(12)).toBe(12n);
    expect(normalizeGeneratedAutomationId("9007199254740993")).toBe(
      9007199254740993n,
    );
    expect(normalizeGeneratedAutomationId(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(normalizeGeneratedAutomationId(0)).toBeNull();
    expect(normalizeGeneratedAutomationId("nope")).toBeNull();
  });
});

