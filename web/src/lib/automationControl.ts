export type TaggedKind = { tag: string };

export type AutomationActionLike = {
  actionKind: TaggedKind;
};

const LIVE_IN_MODULE_ACTIONS = new Set([
  "CreatePage",
  "UpdateProperty",
  "OrchaJob",
]);

/** Actions that cannot run Live until the off-module worker executor exists. */
export function liveAutomationBlockers(
  actions: readonly AutomationActionLike[],
): string[] {
  return [
    ...new Set(
      actions
        .map((action) => action.actionKind.tag)
        .filter((kind) => !LIVE_IN_MODULE_ACTIONS.has(kind)),
    ),
  ];
}

export function canManageAutomation(args: {
  currentIdentityHex: string | undefined;
  createdByHex: string;
  isAdmin: boolean;
}): boolean {
  return (
    args.isAdmin ||
    (args.currentIdentityHex !== undefined &&
      args.currentIdentityHex === args.createdByHex)
  );
}

/** Human-readable JSON for review; malformed legacy config remains visible. */
export function prettyAutomationJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
