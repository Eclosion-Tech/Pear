import { describe, expect, test } from "vitest";
import { collectDocYjsIds, renderDocTree, type DocNode } from "./doc-render";

let nextId = 1;
function node(
  parentId: number | null,
  componentType: string,
  opts: { props?: Record<string, unknown>; order?: number; deleted?: boolean; id?: number } = {},
): DocNode {
  return {
    id: opts.id ?? nextId++,
    parentId,
    componentType,
    props: JSON.stringify(opts.props ?? {}),
    order: opts.order ?? nextId * 1000,
    deleted: opts.deleted ?? false,
  };
}

describe("renderDocTree", () => {
  test("returns undefined without a live root", () => {
    expect(renderDocTree([], () => "")).toBeUndefined();
    expect(renderDocTree([node(null, "Container", { deleted: true })], () => "")).toBeUndefined();
  });

  test("walks heading sections and nested lists at any depth", () => {
    const root = node(null, "Container", { id: 1 });
    const h2 = node(1, "Heading", { id: 2, props: { level: 2 }, order: 1 });
    const para = node(2, "RichText", { id: 3, order: 1 }); // section body under the heading
    const b1 = node(2, "BulletListItem", { id: 4, order: 2 });
    const b1a = node(4, "BulletListItem", { id: 5, order: 1 }); // nested bullet
    const b1a1 = node(5, "ChecklistItem", { id: 6, props: { checked: true }, order: 1 }); // third level
    const b2 = node(2, "BulletListItem", { id: 7, order: 3 });
    const n1 = node(1, "NumberedListItem", { id: 8, order: 2 });
    const n2 = node(1, "NumberedListItem", { id: 9, order: 3 });
    const tail = node(1, "RichText", { id: 10, order: 4 });
    const n3 = node(1, "NumberedListItem", { id: 11, order: 5 }); // numbering restarts after the break
    const texts: Record<number, string> = {
      2: "Plan",
      3: "Intro paragraph",
      4: "first",
      5: "nested",
      6: "done task",
      7: "second",
      8: "one",
      9: "two",
      10: "closing",
      11: "again",
    };
    const nodes = [root, h2, para, b1, b1a, b1a1, b2, n1, n2, tail, n3];

    expect(collectDocYjsIds(nodes).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(renderDocTree(nodes, (id) => texts[id] ?? "")).toBe(
      [
        "## Plan",
        "",
        "Intro paragraph",
        "",
        "- first",
        "  - nested",
        "    - [x] done task",
        "- second",
        "",
        "1. one",
        "2. two",
        "",
        "closing",
        "",
        "1. again",
      ].join("\n"),
    );
  });

  test("containers are transparent; other component types keep a placeholder and their children", () => {
    const root = node(null, "Container", { id: 1 });
    const group = node(1, "Container", { id: 2, order: 1 });
    const item = node(2, "BulletListItem", { id: 3, order: 1 });
    const form = node(1, "Form", { id: 4, order: 2 });
    const input = node(4, "Input", { id: 5, order: 1 });
    const empty = node(1, "Container", { id: 6, order: 3 });
    const out = renderDocTree([root, group, item, form, input, empty], (id) => (id === 3 ? "in group" : ""));
    expect(out).toBe(["- in group", "", "[Form]", "", "[Input]", "", "[Container]"].join("\n"));
  });

  test("reference blocks render their handles; deleted nodes are skipped", () => {
    const root = node(null, "Container", { id: 1 });
    const link = node(1, "PageLink", { id: 2, order: 1, props: { pageId: "42", pageTitle: "Roadmap" } });
    const conv = node(1, "Conversation", { id: 3, order: 2, props: { conversationId: "9" } });
    const gone = node(1, "RichText", { id: 4, order: 3, deleted: true });
    const code = node(1, "CodeRef", {
      id: 5,
      order: 4,
      props: { repo: { kind: "git_remote" }, ref: "main", path: "src/a.ts", range: { startLine: 3, endLine: 9 } },
    });
    const out = renderDocTree([root, link, conv, gone, code], () => "DELETED");
    expect(out).toBe(
      ['[Page link: "Roadmap" page_id=42]', "", "[Conversation conversation_id=9]", "", "[Code ref: src/a.ts:3-9 @ main]"].join("\n"),
    );
    expect(out).not.toContain("DELETED");
  });

  test("multi-line paragraph text nested under a list item is indented per line", () => {
    const root = node(null, "Container", { id: 1 });
    const b = node(1, "BulletListItem", { id: 2, order: 1 });
    const p = node(2, "RichText", { id: 3, order: 1 });
    const out = renderDocTree([root, b, p], (id) => (id === 2 ? "item" : "line a\nline b"));
    expect(out).toBe("- item\n  line a\n  line b");
  });
});
