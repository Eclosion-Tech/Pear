import { describe, expect, it } from "vitest";
import {
  effectivePagePermission,
  pageAccessScope,
  type PageAccessRuleLike,
} from "./pageAccess";

const pages = [{ id: 1n }, { id: 2n, parentId: 1n }, { id: 3n }];
const grant = (
  pageId: bigint,
  hex: string,
  permission: "Read" | "Write",
): PageAccessRuleLike => ({
  pageId,
  principal: { tag: "WorkspaceMember", value: { toHexString: () => hex } },
  permission: { tag: permission },
});

describe("page access (server parity)", () => {
  it("is open to workspace members only when the page and ancestors have no rules", () => {
    const scope = pageAccessScope(2n, pages, [grant(3n, "someone", "Read")]);
    expect(scope.open).toBe(true);
    expect(effectivePagePermission(scope, "member")).toBe("Write");
  });
  it("restricts unmatched members and preserves admin/service access", () => {
    const scope = pageAccessScope(2n, pages, [grant(1n, "reader", "Read")]);
    expect(scope.open).toBe(false);
    expect(effectivePagePermission(scope, "reader")).toBe("Read");
    expect(effectivePagePermission(scope, "other")).toBeNull();
    expect(effectivePagePermission(scope, "admin", true)).toBe("Write");
  });
  it("does not let a direct read grant override inherited write access", () => {
    const scope = pageAccessScope(2n, pages, [
      grant(1n, "member", "Write"),
      grant(2n, "member", "Read"),
    ]);
    expect(effectivePagePermission(scope, "member")).toBe("Write");
    expect(
      effectivePagePermission(
        pageAccessScope(2n, pages, [grant(1n, "member", "Write")]),
        "member",
      ),
    ).toBe("Write");
  });
  it("keeps identities separate even for members with the same email", () => {
    const scope = pageAccessScope(2n, pages, [
      grant(2n, "old-session", "Write"),
    ]);
    expect(effectivePagePermission(scope, "new-session")).toBeNull();
  });
  it("does not claim open access when ancestors are missing or cyclic", () => {
    expect(pageAccessScope(2n, [{ id: 2n, parentId: 1n }], [])).toMatchObject({
      complete: false,
      open: false,
    });
    expect(
      pageAccessScope(
        2n,
        [
          { id: 1n, parentId: 2n },
          { id: 2n, parentId: 1n },
        ],
        [],
      ),
    ).toMatchObject({ complete: false, open: false });
  });
  it("only returns to open access when the final applicable rule is removed", () => {
    expect(pageAccessScope(2n, pages, [grant(1n, "parent", "Read")]).open).toBe(
      false,
    );
    expect(pageAccessScope(2n, pages, []).open).toBe(true);
  });
});
