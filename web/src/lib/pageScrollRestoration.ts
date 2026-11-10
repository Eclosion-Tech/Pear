const historyKey = "pearPageScroll";

type Position = { page: string; href: string; top: number; left: number };

function savedPosition(page: string, href: string): Position | null {
  const value = window.history.state?.[historyKey];
  return value?.page === page && value.href === href &&
    Number.isFinite(value.top) && value.top >= 0 &&
    Number.isFinite(value.left) && value.left >= 0 ? value : null;
}

/** Next restores the window, while Pear documents scroll in their own pane. */
export function trackPageScroll(element: HTMLElement, page: string) {
  const href = window.location.href;
  let target = savedPosition(page, href);
  let frame: number | undefined;
  let disposed = false;
  const active = () => !disposed && window.location.href === href;
  const save = () => {
    if (!active() || target) return;
    window.history.replaceState({
      ...window.history.state,
      [historyKey]: { page, href, top: element.scrollTop, left: element.scrollLeft },
    }, "");
  };
  const onScroll = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = undefined; save(); });
  };
  const restore = () => {
    if (!active() || !target) return;
    element.scrollTop = target.top;
    element.scrollLeft = target.left;
    // Subscriptions and query views can make the page taller after mount.
    // Do not overwrite the requested position with an early clamped value.
    if (Math.abs(element.scrollTop - target.top) < 1 && Math.abs(element.scrollLeft - target.left) < 1) target = null;
  };
  const onPopState = () => {
    if (!active()) return;
    target = savedPosition(page, href);
    restore();
  };
  const onInput = () => { target = null; };
  const mutations = new MutationObserver(restore);
  mutations.observe(element, { childList: true, subtree: true });
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restore);
  resize?.observe(element);
  if (element.firstElementChild) resize?.observe(element.firstElementChild);
  if (target) restore();
  else if (!window.location.hash) {
    element.scrollTop = 0;
    element.scrollLeft = 0;
  }
  element.addEventListener("scroll", onScroll, { passive: true });
  // Capture the exact departure position even if a scroll's animation frame
  // has not run yet when a link/button is activated.
  element.addEventListener("click", save, true);
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) element.addEventListener(event, onInput, { passive: true });
  window.addEventListener("popstate", onPopState);
  return () => {
    disposed = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    mutations.disconnect();
    resize?.disconnect();
    element.removeEventListener("scroll", onScroll);
    element.removeEventListener("click", save, true);
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) element.removeEventListener(event, onInput);
    window.removeEventListener("popstate", onPopState);
  };
}
