import {
  canonicalJson,
  createBaselineCatalog,
  validateDocument,
  TrellisError,
  sha256,
  type Json,
  type JsonObject,
  type TemplateDefinition,
  type UiDocument,
} from "@eclosion-tech/trellis";
import bundle from "../panel-template.json" with { type: "json" };

export const PAGE_PANEL_TYPE = "TrellisPanel";
export const PAGE_PANEL_VERSION = "pear_trellis_panel_v1";
export const PAGE_REFERENCE_VERSION = "pear_page_component_v1";
export const PAGE_PANEL_ACTION = "pear.panel.note.save";
export const PAGE_PANEL_TEMPLATE =
  bundle.template as unknown as TemplateDefinition;
export const PAGE_PANEL_DEFAULTS = bundle.defaults;
export const PAGE_PANEL_CATALOG = createBaselineCatalog([PAGE_PANEL_ACTION]);
export type PanelParameters = typeof bundle.defaults;
export type PanelReceipt = {
  principal: string;
  requestId: string;
  fingerprint: string;
  revision: number;
};
export type PagePanel = {
  v: typeof PAGE_PANEL_VERSION;
  templateId: string;
  templateVersion: string;
  templateHash: string;
  revision: number;
  parameters: PanelParameters;
  creation: {
    principal: string;
    parentId: string;
    requestId: string;
    fingerprint: string;
  };
  updatedBy: string;
  receipts: PanelReceipt[];
};
export type PageComponentReference = {
  v: typeof PAGE_REFERENCE_VERSION;
  surfaceId: string;
  blockId: string;
};
function invalid(message: string): never {
  throw new TrellisError("INVALID_PAGE_PANEL", "$", message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(
  value: unknown,
  fields: string[],
): asserts value is Record<string, unknown> {
  if (
    !object(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    invalid("Unexpected panel fields.");
}
export function panelId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    invalid("Expected a positive decimal page/component ID.");
  return value;
}
export function panelRequestId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
  )
    invalid("Expected a bounded stable request ID.");
  return value;
}
function checkParameters(
  value: unknown,
): asserts value is Record<string, string> {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !Object.hasOwn(bundle.defaults, key))
  )
    invalid("Only the declared panel parameters can change.");
  for (const [key, raw] of Object.entries(value)) {
    const schema = PAGE_PANEL_TEMPLATE.parameters.properties![key];
    if (
      typeof raw !== "string" ||
      raw.length < (schema.minLength ?? 0) ||
      raw.length > (schema.maxLength ?? 4000)
    )
      invalid(`Invalid panel parameter: ${key}.`);
  }
}
export function panelChanges(value: unknown): Partial<PanelParameters> {
  checkParameters(value);
  if (new TextEncoder().encode(canonicalJson(value)).length > 16000)
    invalid("Panel changes exceed the size limit.");
  return JSON.parse(canonicalJson(value)) as Partial<PanelParameters>;
}
const identity = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fingerprint = identity;
export function readPagePanel(json: string): PagePanel {
  if (new TextEncoder().encode(json).length > 128000)
    invalid("Saved panel exceeds the size limit.");
  const value: unknown = JSON.parse(json);
  exact(value, [
    "v",
    "templateId",
    "templateVersion",
    "templateHash",
    "revision",
    "parameters",
    "creation",
    "updatedBy",
    "receipts",
  ]);
  if (
    value.v !== PAGE_PANEL_VERSION ||
    value.templateId !== PAGE_PANEL_TEMPLATE.id ||
    value.templateVersion !== PAGE_PANEL_TEMPLATE.version ||
    value.templateHash !== PAGE_PANEL_TEMPLATE.hash
  )
    invalid("This panel requires another template version.");
  if (
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !identity(value.updatedBy)
  )
    invalid("Invalid panel revision/author.");
  exact(value.parameters, Object.keys(bundle.defaults));
  checkParameters(value.parameters);
  exact(value.creation, ["principal", "parentId", "requestId", "fingerprint"]);
  if (
    !identity(value.creation.principal) ||
    !fingerprint(value.creation.fingerprint)
  )
    invalid("Invalid panel creation receipt.");
  panelId(value.creation.parentId);
  panelRequestId(value.creation.requestId);
  if (
    !Array.isArray(value.receipts) ||
    value.receipts.length < 1 ||
    value.receipts.length > 32
  )
    invalid("Invalid panel receipts.");
  const seen = new Set<string>();
  for (const receipt of value.receipts) {
    exact(receipt, ["principal", "requestId", "fingerprint", "revision"]);
    if (
      !identity(receipt.principal) ||
      !fingerprint(receipt.fingerprint) ||
      !Number.isSafeInteger(receipt.revision) ||
      (receipt.revision as number) < 0 ||
      (receipt.revision as number) > (value.revision as number)
    )
      invalid("Invalid panel receipt.");
    const key = `${receipt.principal}:${panelRequestId(receipt.requestId)}`;
    if (seen.has(key)) invalid("Duplicate panel receipt.");
    seen.add(key);
  }
  return value as unknown as PagePanel;
}
function substitute(value: Json, parameters: JsonObject): Json {
  if (Array.isArray(value))
    return value.map((item) => substitute(item, parameters));
  if (object(value)) {
    if (Object.keys(value).length === 1 && typeof value.$param === "string")
      return parameters[value.$param];
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substitute(item as Json, parameters),
      ]),
    );
  }
  return value;
}
/** Materialize a view of the component row; there is no second saved document. */
export function pagePanelDocument(
  panel: PagePanel,
  surfaceId: string,
  blockId: string,
): UiDocument {
  panelId(surfaceId);
  panelId(blockId);
  const instanceId = `pear-component:${blockId}`;
  const template = PAGE_PANEL_TEMPLATE;
  const mapping = Object.fromEntries(
    template.nodes.map((node) => [
      node.id as string,
      `${instanceId}:${node.id}`,
    ]),
  );
  const nodes = template.nodes.map((raw) => {
    const node = substitute(raw, panel.parameters) as JsonObject;
    return {
      ...node,
      id: mapping[raw.id as string],
      parentId: raw.parentId === null ? null : mapping[raw.parentId as string],
      ...(node.action
        ? {
            action: { ...(node.action as JsonObject), slot: PAGE_PANEL_ACTION },
          }
        : {}),
    };
  });
  return validateDocument(
    {
      protocol: "trellis_ui_v1",
      documentId: `pear-page:${surfaceId}:component:${blockId}`,
      revision: panel.revision,
      catalogVersion: PAGE_PANEL_CATALOG.version,
      rootId: mapping[template.rootId],
      nodes,
      retiredIds: [],
      template: {
        id: template.id,
        version: template.version,
        hash: template.hash,
        instanceId,
        parameters: panel.parameters,
        mapping,
        actionBindings: { save: PAGE_PANEL_ACTION },
        state: "linked",
      },
    },
    PAGE_PANEL_CATALOG,
  );
}
export function readPageComponentReference(
  json: string,
): PageComponentReference {
  if (json.length > 500) invalid("Component reference is too large.");
  const value: unknown = JSON.parse(json);
  exact(value, ["v", "surfaceId", "blockId"]);
  if (value.v !== PAGE_REFERENCE_VERSION)
    invalid("Unsupported component reference.");
  panelId(value.surfaceId);
  panelId(value.blockId);
  return value as unknown as PageComponentReference;
}

export type PanelCommit = {
  componentId: string;
  baseRevision: number;
  requestId: string;
  parameters: Partial<PanelParameters>;
};
export class PanelCommitError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
/** The same observer is used by human settings, actions and agent tools. */
export async function commitObservedPagePanel(
  input: PanelCommit,
  host: {
    principal: string;
    commit: (input: PanelCommit) => Promise<unknown>;
    read: () => PagePanel | null | Promise<PagePanel | null>;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<PagePanel> {
  input = {
    componentId: input.componentId,
    baseRevision: input.baseRevision,
    requestId: input.requestId,
    parameters: panelChanges(input.parameters),
  };
  panelId(input.componentId);
  panelRequestId(input.requestId);
  panelChanges(input.parameters);
  if (
    !identity(host.principal) ||
    !Number.isSafeInteger(input.baseRevision) ||
    input.baseRevision < 0
  )
    invalid("Invalid commit principal/revision.");
  const fingerprint = await sha256({
    operation: "update",
    baseRevision: input.baseRevision,
    parameters: input.parameters,
  });
  function checkSession() {
    if (host.signal?.aborted)
      throw new PanelCommitError(
        "SESSION_ENDED",
        "This editing session ended.",
      );
  }
  checkSession();
  let error: unknown;
  try {
    await host.commit(input);
  } catch (caught) {
    if (caught instanceof PanelCommitError) throw caught;
    const message = caught instanceof Error ? caught.message : String(caught);
    const code =
      /\b(STALE_REVISION|REQUEST_REUSED|INVALID_PAGE_PANEL|PANEL_DELETED):/.exec(
        message,
      )?.[1];
    if (code) throw new PanelCommitError(code, message);
    if (
      /lacks .*access|Authentication required|deleted|not found|not a Trellis panel/i.test(
        message,
      )
    )
      throw new PanelCommitError("AUTHORIZATION_DENIED", message);
    error = caught;
  }
  const deadline = Date.now() + (host.timeoutMs ?? 3000);
  do {
    checkSession();
    try {
      const saved = await host.read();
      checkSession();
      const receipt = saved?.receipts.find(
        (r) =>
          r.principal === host.principal && r.requestId === input.requestId,
      );
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new PanelCommitError(
            "REQUEST_REUSED",
            "This request ID has different arguments.",
          );
        return saved!;
      }
    } catch (caught) {
      if (caught instanceof PanelCommitError) throw caught;
      error ??= caught;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new PanelCommitError(
    "COMMIT_UNCONFIRMED",
    `The saved receipt was not observed. Retry the identical request.${error instanceof Error ? " " + error.message : ""}`,
  );
}
