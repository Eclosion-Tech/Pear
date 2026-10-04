import { describe, expect, it } from "vitest";
import { blockReferenceHref, parseBlockReferenceLink } from "./blockReferenceLink";

describe("reference source links", () => {
  const origin = "https://pear.example";
  it("accepts page links and both existing block deep-link formats", () => {
    expect(parseBlockReferenceLink("/workspace/42", origin)).toEqual({ surfaceId: 42n });
    expect(parseBlockReferenceLink(`${origin}/workspace/42#c-9007199254740993`, origin))
      .toEqual({ surfaceId: 42n, blockId: 9007199254740993n });
    expect(parseBlockReferenceLink("/workspace/42?node=17", origin)).toEqual({ surfaceId: 42n, blockId: 17n });
    expect(blockReferenceHref({ surfaceId: 42n, blockId: 17n })).toBe("/workspace/42#c-17");
  });
  it.each(["https://other.example/workspace/42", "javascript:alert(1)", "/workspace/0", "/workspace/42#c-bad",
    "/workspace/42?node=-1", "/workspace/18446744073709551616", "/workspace/42#c-18446744073709551616"])("rejects invalid or foreign source %s", (value) => {
    expect(parseBlockReferenceLink(value, origin)).toBeNull();
  });
});
