import { describe, it, expect } from "vitest";
import { answerTools, validAnswerInput } from "./answers";
import {
  parseScope,
  toolFilterForScopes,
  DEFAULT_SCOPE,
} from "../mcp-oauth/scopes";
import { relaySignature, verifyRelay, boundedJson } from "./answer-relay";
const id = "11111111-1111-4111-a111-111111111111",
  fp = "a".repeat(64);
describe("scoped answer MCP surface", () => {
  it("does not widen defaults or grant execution through memory/page scopes", () => {
    expect(DEFAULT_SCOPE).toEqual(["memory"]);
    for (const tool of answerTools())
      expect(toolFilterForScopes(["memory", "pages:write"])(tool.name)).toBe(
        false,
      );
    expect(toolFilterForScopes(["execution:read"])("prepare_answer")).toBe(
      true,
    );
    expect(toolFilterForScopes(["execution:read"])("run_answer")).toBe(false);
    expect(parseScope("execution:read execution:answer").unknown).toEqual([]);
  });
  it("remains disabled without a host-backed OAuth capability", async () => {
    const result = await answerTools()[0].execute({} as any, {});
    expect(JSON.parse(result)).toEqual({
      ok: false,
      error: "answer_api_unavailable",
    });
  });
  it.each([
    {},
    { approvalId: id, offerFingerprint: fp, approved: false },
    {
      approvalId: id,
      offerFingerprint: fp,
      approved: true,
      prompt: "override",
    },
    { approvalId: "other", offerFingerprint: fp, approved: true },
  ])("refuses incomplete/changed execution input %j", async (input) => {
    let calls = 0;
    const ctx: any = {
      answers: {
        invoke: async () => {
          calls++;
          return { ok: true };
        },
      },
    };
    const result = await answerTools()
      .find((t) => t.name === "run_answer")!
      .execute(ctx, input);
    expect(JSON.parse(result).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it("accepts only text plus explicit Claude selection, never raw payloads/models/context", () => {
    expect(
      validAnswerInput("prepare", {
        profileId: "bridge_2_claude-code",
        text: "Question",
      }),
    ).toBe(true);
    for (const extra of [
      { model: "paid" },
      { context: "repo" },
      { approved: true },
    ])
      expect(
        validAnswerInput("prepare", {
          profileId: "bridge_2_claude-code",
          text: "Question",
          ...extra,
        }),
      ).toBe(false);
    expect(
      validAnswerInput("prepare", {
        profileId: "bridge_2_codex",
        text: "Question",
      }),
    ).toBe(false);
    expect(
      validAnswerInput("prepare", {
        profileId: "bridge_2_claude-code",
        text: "é".repeat(4097),
      }),
    ).toBe(false);
    expect(validAnswerInput("list", [] as any)).toBe(false);
  });
  it("get is an explicitly separate action and errors never export host diagnostics", async () => {
    const seen: string[] = [];
    const ctx: any = {
      answers: {
        invoke: async (action: string) => {
          seen.push(action);
          throw new Error("SECRET upstream body");
        },
      },
    };
    const out = await answerTools()
      .find((t) => t.name === "get_answer")!
      .execute(ctx, { approvalId: id });
    expect(seen).toEqual(["get"]);
    expect(out).not.toContain("SECRET");
  });
});
describe("answer relay authentication", () => {
  it("binds timestamp and the full body, with a finite replay window", async () => {
    const secret = "a".repeat(64),
      stamp = String(Date.now()),
      body = '{"action":"prepare"}',
      sig = await relaySignature(secret, stamp, body);
    expect(await verifyRelay(secret, stamp, body, sig)).toBe(true);
    expect(await verifyRelay(secret, stamp, body + " ", sig)).toBe(false);
    expect(await verifyRelay("b".repeat(64), stamp, body, sig)).toBe(false);
    expect(
      await verifyRelay(secret, stamp, body, sig, Number(stamp) + 30001),
    ).toBe(false);
    expect(await verifyRelay(secret, stamp, body, "bad")).toBe(false);
  });
  it("bounds bodies without echoing sensitive content", async () => {
    await expect(
      boundedJson(new Response("SECRET".repeat(20)), 10),
    ).rejects.toThrow("answer_response_too_large");
  });
});
