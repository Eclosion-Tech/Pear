import { describe, expect, it } from "vitest";
import { preparePearTrellisUi } from "./trellisGeneratedUi";

function fixture() {
  return {
    v: "component_tree_v1",
    root_id: 1,
    nodes: [
      {
        id: 1,
        parent_id: null,
        component_type: "Container",
        props: "{}",
        order: 0,
        yjs_b64: null,
      },
      {
        id: 2,
        parent_id: 1,
        component_type: "Input",
        props: JSON.stringify({ name: "note", label: "Note", required: true }),
        order: 0,
        yjs_b64: null,
      },
      {
        id: 3,
        parent_id: 1,
        component_type: "Button",
        props: JSON.stringify({
          label: "Save",
          action: {
            type: "trigger_automation",
            automationId: 42,
            input: { note: "$form.note" },
            confirmation: "Save this note?",
          },
        }),
        order: 1,
        yjs_b64: null,
      },
    ],
  };
}
describe("Pear Trellis projection", () => {
  it("retains the existing action provider contract and original node identities", () => {
    const result = preparePearTrellisUi(JSON.stringify(fixture()), 123n);
    expect(result.document.documentId).toBe("pear-message:123");
    expect(result.actionsByNode.get("3")).toEqual({
      automationId: "42",
      input: { note: "$form.note" },
      confirmation: "Save this note?",
    });
    expect(result.document.nodes[2].action?.input.note).toEqual({
      field: "note",
    });
  });
  it("rejects lossy wire IDs instead of silently changing the action node identity", () => {
    const raw = fixture();
    raw.nodes[2].id = Number.MAX_SAFE_INTEGER + 1;
    expect(() => preparePearTrellisUi(JSON.stringify(raw), 123n)).toThrow();
  });
  it("leaves unsupported historical layouts to the legacy renderer", () => {
    const raw = fixture();
    raw.nodes[0].props = JSON.stringify({ layout: "grid" });
    expect(() => preparePearTrellisUi(JSON.stringify(raw), 123n)).toThrow();
  });
});
