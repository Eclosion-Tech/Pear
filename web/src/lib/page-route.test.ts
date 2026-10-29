import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  params: { id: "42" } as { id?: unknown } | null,
  pages: [] as { id: bigint; deletedAt: number | null; pageType: { tag: string } }[],
  ready: false,
}));
vi.mock("next/navigation", () => ({ useParams: () => state.params }));
vi.mock("spacetimedb/react", () => ({ useTable: vi.fn(() => [state.pages, state.ready]) }));
vi.mock("@/src/module_bindings", () => ({ tables: { page: {} } }));
vi.mock("@/src/components/DocPage", () => ({
  DocPage: ({ page }: { page: { id: bigint } }) => createElement("p", null, `Document ${page.id}`),
}));
vi.mock("@/src/components/DatabasePage", () => ({
  DatabasePage: ({ page }: { page: { id: bigint } }) => createElement("p", null, `Database ${page.id}`),
}));
import { useTable } from "spacetimedb/react";
import { parsePageId } from "@/src/lib/page-id";
import PageRoute from "../../app/workspace/[id]/page";

const render = () => renderToStaticMarkup(createElement(PageRoute));
beforeEach(() => {
  state.params = { id: "42" };
  state.pages = [];
  state.ready = false;
  vi.clearAllMocks();
});

describe("generic page route", () => {
  it("renders not found for malformed parameters before subscription readiness, without skipping the subscription hook", () => {
    const invalid = [undefined, null, ["42"], 42, {}, "", "operations", "-1", "+42", " 42", "42 ", "42\n", "42\r\n", "1.0", "1e3", "0x2a", "18446744073709551616", "9".repeat(1000)];
    for (const id of invalid) {
      state.params = { id };
      expect(render()).toContain("Page not found.");
    }
    state.params = null;
    expect(render()).toContain("Page not found.");
    expect(useTable).toHaveBeenCalledTimes(invalid.length + 1);
  });

  it("keeps decimal u64 IDs precise, including the upper boundary", () => {
    expect(parsePageId("0")).toBe(0n);
    expect(parsePageId("00042")).toBe(42n);
    const maximum = "18446744073709551615";
    expect(parsePageId(maximum)).toBe(18446744073709551615n);
    state.params = { id: maximum };
    state.pages = [{ id: 18446744073709551615n, deletedAt: null, pageType: { tag: "Doc" } }];
    expect(render()).toContain(`Document ${maximum}`);
  });

  it("renders cached documents, databases and deleted pages before readiness", () => {
    const page = { id: 42n, deletedAt: null as number | null, pageType: { tag: "Doc" } };
    state.pages = [page];
    expect(render()).toContain("Document 42");
    page.pageType.tag = "Database";
    expect(render()).toContain("Database 42");
    page.deletedAt = 1;
    expect(render()).toContain("This page has been deleted.");
  });

  it("waits for a valid uncached ID, then reports not found after readiness", () => {
    expect(render()).toContain("Loading…");
    state.ready = true;
    expect(render()).toContain("Page not found.");
  });
});
