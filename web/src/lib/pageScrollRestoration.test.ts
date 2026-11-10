// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { trackPageScroll } from "./pageScrollRestoration";

let pane: HTMLDivElement;
let cleanup: (() => void) | undefined;
beforeEach(() => {
  pane = document.createElement("div"); document.body.append(pane);
  window.history.replaceState({ __NA: true, tree: { preserved: true } }, "", "/workspace/acme/7?view=product");
});
afterEach(() => { cleanup?.(); cleanup = undefined; pane.remove(); vi.restoreAllMocks(); });
const scroll = async (top: number) => {
  pane.scrollTop = top; pane.dispatchEvent(new Event("scroll"));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
};

it("preserves Next history state and restores the nested pane after a record round trip", async () => {
  const url = window.location.href;
  cleanup = trackPageScroll(pane, "acme:7");
  await scroll(840);
  expect(window.history.state).toMatchObject({ __NA: true, tree: { preserved: true }, pearPageScroll: { page: "acme:7", href: url, top: 840 } });
  window.history.pushState({ __NA: true }, "", "/workspace/acme/11");
  cleanup(); cleanup = trackPageScroll(pane, "acme:11");
  expect(pane.scrollTop).toBe(0);
  await scroll(150);
  await new Promise<void>(resolve => {
    window.addEventListener("popstate", () => resolve(), { once: true }); window.history.back();
  });
  cleanup(); cleanup = trackPageScroll(pane, "acme:7");
  expect(window.location.href).toBe(url);
  expect(pane.scrollTop).toBe(840);
  expect(window.history.state.tree).toEqual({ preserved: true });
});

it("waits for async component rows to make the saved position reachable", async () => {
  let height = 100, top = 0;
  Object.defineProperty(pane, "scrollTop", { get: () => top, set: value => { top = Math.min(value, height); } });
  window.history.replaceState({ pearPageScroll: { page: "acme:7", href: window.location.href, top: 840, left: 0 } }, "");
  cleanup = trackPageScroll(pane, "acme:7");
  expect(top).toBe(100);
  pane.dispatchEvent(new Event("scroll"));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  expect(window.history.state.pearPageScroll.top).toBe(840);
  height = 1500;
  pane.append(document.createElement("div"));
  await vi.waitFor(() => expect(top).toBe(840));
});

it("saves the exact click position before the throttled scroll callback", () => {
  cleanup = trackPageScroll(pane, "acme:7");
  pane.scrollTop = 375; pane.dispatchEvent(new Event("click", { bubbles: true }));
  expect(window.history.state.pearPageScroll.top).toBe(375);
});

it("never writes an old page's pending scroll into the new route", async () => {
  cleanup = trackPageScroll(pane, "acme:7");
  pane.scrollTop = 300; pane.dispatchEvent(new Event("scroll"));
  window.history.pushState({ nextPage: true }, "", "/workspace/acme/11");
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  expect(window.history.state).toEqual({ nextPage: true });
});

it("ignores mismatched or malformed saved positions and yields to user scrolling", async () => {
  for (const position of [
    { page: "other:7", top: 400 }, { page: "acme:7", top: -1 }, { page: "acme:7", top: "400" },
  ]) {
    window.history.replaceState({ pearPageScroll: { href: window.location.href, left: 0, ...position } }, "");
    pane.scrollTop = 500;
    cleanup = trackPageScroll(pane, "acme:7");
    expect(pane.scrollTop).toBe(0); cleanup();
  }
  let top = 0;
  Object.defineProperty(pane, "scrollTop", { get: () => top, set: value => { top = Math.min(value, 100); } });
  window.history.replaceState({ pearPageScroll: { page: "acme:7", href: window.location.href, top: 840, left: 0 } }, "");
  cleanup = trackPageScroll(pane, "acme:7");
  pane.dispatchEvent(new Event("wheel"));
  await scroll(50);
  expect(window.history.state.pearPageScroll.top).toBe(50);
});
