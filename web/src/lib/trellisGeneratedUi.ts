import { readSavedUi, CATALOG, SAVED_UI_VERSION } from "@pear/trellis-ui";
import {
  convertLegacyComponentTreeV1,
  createBaselineCatalog,
  TrellisError,
  type Catalog,
  type UiDocument,
} from "@eclosion-tech/trellis";
import { decodeLegacyBase64 } from "@eclosion-tech/trellis/pulp";
import {
  normalizeGeneratedAutomationId,
  type GeneratedUiInputBindings,
} from "./generatedUiActions";

export type PearLegacyAction = {
  automationId: string;
  input: GeneratedUiInputBindings;
  confirmation?: string;
};
export type PreparedPearUi = {
  document: UiDocument;
  catalog: Catalog;
  actionsByNode: ReadonlyMap<string, PearLegacyAction>;
};

/** Project the existing message payload. Binding an action never authorizes its execution. */
export function preparePearTrellisUi(
  json: string,
  messageId: bigint,
): PreparedPearUi {
  if (JSON.parse(json)?.v === SAVED_UI_VERSION) {
    const saved = readSavedUi(json, messageId);
    const actionsByNode = new Map<string, PearLegacyAction>();
    for (const node of saved.document.nodes) {
      if (node.action && saved.bindings.submit)
        actionsByNode.set(node.id, saved.bindings.submit);
    }
    return { document: saved.document, catalog: CATALOG, actionsByNode };
  }
  const catalog = createBaselineCatalog();
  const bySlot = new Map<string, PearLegacyAction>();
  const document = convertLegacyComponentTreeV1(json, {
    documentId: `pear-message:${messageId}`,
    catalog,
    decodeText: decodeLegacyBase64,
    resolveAction(action) {
      const automationId = normalizeGeneratedAutomationId(action.automationId);
      if (automationId === null)
        throw new TrellisError(
          "INVALID_ACTION",
          "$.action",
          "Invalid Pear automation reference.",
        );
      if (
        action.confirmation !== undefined &&
        typeof action.confirmation !== "string"
      )
        throw new TrellisError(
          "INVALID_ACTION",
          "$.action.confirmation",
          "Invalid confirmation text.",
        );
      const slot = `legacy-automation-${bySlot.size + 1}`;
      bySlot.set(slot, {
        automationId: String(automationId),
        input: (action.input ?? {}) as GeneratedUiInputBindings,
        ...(action.confirmation !== undefined
          ? { confirmation: action.confirmation }
          : {}),
      });
      catalog.actions = [...catalog.actions, slot];
      return slot;
    },
  });
  const actionsByNode = new Map<string, PearLegacyAction>();
  for (const node of document.nodes)
    if (node.action) actionsByNode.set(node.id, bySlot.get(node.action.slot)!);
  return { document, catalog, actionsByNode };
}
