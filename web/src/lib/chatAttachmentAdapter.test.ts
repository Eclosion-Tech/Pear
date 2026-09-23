import { describe, expect, it, vi } from "vitest";
import {
  createChatAttachmentAdapter,
  parsePageDrop,
} from "./chatAttachmentAdapter";
import type { AttachmentSpec } from "../module_bindings/types";

async function collect<T>(input: Promise<T> | AsyncGenerator<T, void>) {
  if (Symbol.asyncIterator in input) {
    const results: T[] = [];
    for await (const value of input) results.push(value);
    return results;
  }
  return [await input];
}

describe("chat attachment adapter", () => {
  it.each([
    ["photo.png", "image/png", "Image"],
    ["notes.pdf", "application/pdf", "File"],
  ])(
    "uploads and sends %s with its storage key",
    async (name, mimeType, tag) => {
      const store = createChatAttachmentAdapter(
        async () => "workspaces/demo/object",
        vi.fn(),
      );
      const states = await collect(
        store.adapter.add({
          file: new File(["bytes"], name, { type: mimeType }),
        }),
      );
      expect(states.map((state) => state.status.type)).toEqual([
        "running",
        "requires-action",
      ]);
      const sent = await store.adapter.send(states[1]);
      expect(store.resolve([sent])).toMatchObject([
        {
          kind: { tag },
          fileName: name,
          mimeType,
          objectKey: "workspaces/demo/object",
        },
      ]);
      // Keep the mapping until the reducer succeeds so a rejected send can retry.
      expect(store.resolve([sent])).toHaveLength(1);
      store.release([sent]);
      expect(() => store.resolve([sent])).toThrow("unavailable");
    },
  );
  it.each([false, true])(
    "marks failed uploads as errors and prevents sending (throws=%s)",
    async (throws) => {
      const report = vi.fn();
      const store = createChatAttachmentAdapter(async () => {
        if (throws) throw new Error("Network unavailable");
        return null;
      }, report);
      const states = await collect(
        store.adapter.add({ file: new File(["x"], "test.txt") }),
      );
      expect(states[1].status.type).toBe("incomplete");
      expect(report).toHaveBeenCalledOnce();
      await expect(store.adapter.send(states[1])).rejects.toThrow("not ready");
    },
  );
  it("does not re-add an attachment removed during upload", async () => {
    let finish!: (key: string) => void;
    const store = createChatAttachmentAdapter(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      vi.fn(),
    );
    const stream = store.adapter.add({
      file: new File(["x"], "test.txt"),
    }) as AsyncGenerator;
    const first = await stream.next();
    const next = stream.next();
    await store.adapter.remove(first.value);
    finish("workspaces/demo/object");
    expect((await next).done).toBe(true);
    expect(() => store.resolve([first.value])).toThrow("unavailable");
  });
  it("retains page ids and selected text as structured context", () => {
    const store = createChatAttachmentAdapter(vi.fn(), vi.fn());
    const page: AttachmentSpec = {
      kind: { tag: "Page" },
      pageId: 42n,
      fileName: "Roadmap",
      objectKey: undefined,
      mimeType: undefined,
      contentSnapshot: undefined,
    };
    const selection: AttachmentSpec = {
      ...page,
      kind: { tag: "Blocks" },
      contentSnapshot: "Selected paragraph",
    };
    store.register("page", page);
    store.register("selection", selection);
    expect(store.resolve([{ id: "page" }, { id: "selection" }])).toEqual([
      page,
      selection,
    ]);
  });
});

describe("page drag payload", () => {
  it("preserves large page ids without number precision loss", () => {
    expect(
      parsePageDrop('{"pageId":"18446744073709551615","title":"Roadmap"}')
        ?.pageId,
    ).toBe(18446744073709551615n);
  });
  it.each([
    "invalid",
    "null",
    '{"pageId":"-1"}',
    '{"pageId":"1.2"}',
    '{"pageId":42}',
    '{"pageId":"18446744073709551616"}',
  ])("rejects malformed payload %s", (raw) => {
    expect(parsePageDrop(raw)).toBeNull();
  });
});
