import { describe, expect, test } from "vitest";
import {
  canManageAutomation,
  liveAutomationBlockers,
  prettyAutomationJson,
} from "./automationControl";

describe("liveAutomationBlockers", () => {
  test("accepts the actions implemented transactionally in the module", () => {
    expect(
      liveAutomationBlockers([
        { actionKind: { tag: "CreatePage" } },
        { actionKind: { tag: "UpdateProperty" } },
        { actionKind: { tag: "OrchaJob" } },
      ]),
    ).toEqual([]);
  });

  test("returns each worker-only action once", () => {
    expect(
      liveAutomationBlockers([
        { actionKind: { tag: "SendEmail" } },
        { actionKind: { tag: "HttpRequest" } },
        { actionKind: { tag: "SendEmail" } },
      ]),
    ).toEqual(["SendEmail", "HttpRequest"]);
  });
});

describe("canManageAutomation", () => {
  test("allows the creating identity", () => {
    expect(
      canManageAutomation({
        currentIdentityHex: "creator",
        createdByHex: "creator",
        isAdmin: false,
      }),
    ).toBe(true);
  });

  test("allows an admin and rejects an unrelated member", () => {
    expect(
      canManageAutomation({
        currentIdentityHex: "admin",
        createdByHex: "agent",
        isAdmin: true,
      }),
    ).toBe(true);
    expect(
      canManageAutomation({
        currentIdentityHex: "member",
        createdByHex: "agent",
        isAdmin: false,
      }),
    ).toBe(false);
  });
});

describe("prettyAutomationJson", () => {
  test("formats valid JSON and preserves malformed legacy config", () => {
    expect(prettyAutomationJson('{"page_id":12}')).toBe(
      '{\n  "page_id": 12\n}',
    );
    expect(prettyAutomationJson("not-json")).toBe("not-json");
  });
});
