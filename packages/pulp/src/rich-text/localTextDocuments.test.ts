import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { connectLocalTextDocument } from "./localTextDocuments";

describe("local source text synchronization", () => {
  it("isolates workspaces and stops mirroring after the occurrence unmounts", () => {
    const original = new Y.Doc(), included = new Y.Doc(), otherWorkspace = new Y.Doc();
    const cleanups = [connectLocalTextDocument("workspace-a", 1n, original),
      connectLocalTextDocument("workspace-a", 1n, included), connectLocalTextDocument("workspace-b", 1n, otherWorkspace)];
    try {
      original.getText("text").insert(0, "Shared");
      expect(included.getText("text").toString()).toBe("Shared");
      expect(otherWorkspace.getText("text").toString()).toBe("");
      cleanups[1]();
      original.getText("text").insert(6, " update");
      expect(included.getText("text").toString()).toBe("Shared");
    } finally { cleanups.forEach((fn) => fn()); [original, included, otherWorkspace].forEach((doc) => doc.destroy()); }
  });

  it("hydrates a newly mounted occurrence from unsaved source edits", () => {
    const original = new Y.Doc(), included = new Y.Doc();
    const stopSource = connectLocalTextDocument("mount-test", 1n, original);
    original.getText("text").insert(0, "Unsaved edit");
    const stopIncluded = connectLocalTextDocument("mount-test", 1n, included);
    try { expect(included.getText("text").toString()).toBe("Unsaved edit"); }
    finally { stopIncluded(); stopSource(); original.destroy(); included.destroy(); }
  });
});
