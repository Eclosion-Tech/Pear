export type PagePermission = "Read" | "Write";
type IdentityLike = { toHexString(): string };
export type PageAccessRuleLike = {
  pageId: bigint;
  principal: { tag: "WorkspaceMember"; value: IdentityLike };
  permission: { tag: PagePermission };
};

/** Mirrors access_control/helpers.rs: grants are additive across ancestors. */
export function pageAccessScope<T extends PageAccessRuleLike>(
  pageId: bigint,
  pages: readonly { id: bigint; parentId?: bigint }[],
  rules: readonly T[],
) {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const ids = new Set<bigint>();
  let current: bigint | undefined = pageId;
  let complete = true;
  while (current != null) {
    if (ids.has(current)) {
      complete = false;
      break;
    }
    ids.add(current);
    const page = byId.get(current);
    if (!page) {
      complete = false;
      break;
    }
    current = page.parentId;
  }
  const applicable = rules.filter((rule) => ids.has(rule.pageId));
  return {
    rules: applicable,
    complete,
    open: complete && applicable.length === 0,
  };
}

export function effectivePagePermission(
  scope: ReturnType<typeof pageAccessScope>,
  identityHex: string,
  privileged = false,
): PagePermission | null {
  if (privileged || scope.open) return "Write";
  const grants = scope.rules.filter(
    (rule) => rule.principal.value.toHexString() === identityHex,
  );
  if (grants.some((rule) => rule.permission.tag === "Write")) return "Write";
  return grants.length ? "Read" : null;
}
