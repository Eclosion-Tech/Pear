import {
  canonicalJson,
  createBaselineCatalog,
  instantiateTemplate,
  updateTemplateParameters,
  validateDocument,
  TrellisError,
  type Json,
  type JsonObject,
  type TemplateDefinition,
  type UiDocument,
} from "@eclosion-tech/trellis";
import definitions from "../templates.json" with { type: "json" };

export * from "./page-panels.js";
export * from "./interfaces.js";

export const SAVED_UI_VERSION = "pear_trellis_ui_v1";
export const CATALOG = createBaselineCatalog(["pear.manual-automation"]);
export const TEMPLATES =
  definitions as unknown as readonly TemplateDefinition[];
export type AutomationBinding = {
  automationId: string;
  input: Record<string, string | number | boolean | null>;
  confirmation?: string;
};
export type SavedUiPayload = {
  v: typeof SAVED_UI_VERSION;
  document: UiDocument;
  bindings: { submit?: AutomationBinding };
};
export type CommitReceipt = {
  requestId: string;
  intentHash: string;
  payloadHash: string;
  revision: number;
};
export type SavedUi = SavedUiPayload & { receipts: CommitReceipt[] };

function reject(message: string): never {
  throw new TrellisError("INVALID_SAVED_UI", "$", message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(
  value: unknown,
  allowed: string[],
): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some((k) => !allowed.includes(k)))
    reject("Unexpected saved-interface fields.");
}
export function templateById(id: string, version: string): TemplateDefinition {
  const template = TEMPLATES.find((t) => t.id === id && t.version === version);
  if (!template) reject("This template version is not bundled with this host.");
  return template;
}
export function defaultParameters(template: TemplateDefinition): JsonObject {
  return template.id === "pear.automation-form"
    ? {
        title: "Command form",
        body: "",
        fieldLabel: "Value",
        placeholder: "",
        defaultValue: "",
        buttonLabel: "Run automation",
      }
    : { title: "Summary", body: "" };
}
export function validateBinding(input: unknown): AutomationBinding {
  keys(input, ["automationId", "input", "confirmation"]);
  if (
    typeof input.automationId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(input.automationId) ||
    BigInt(input.automationId) > 18446744073709551615n
  )
    reject("Expected a positive decimal automation ID.");
  if (!object(input.input) || Object.keys(input.input).length > 32)
    reject("Expected bounded automation input mappings.");
  for (const [key, value] of Object.entries(input.input)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
      ["constructor", "prototype", "__proto__"].includes(key)
    )
      reject("Invalid automation input name.");
    if (
      value !== null &&
      !["string", "number", "boolean"].includes(typeof value)
    )
      reject("Automation inputs must be scalar values.");
    if (typeof value === "number" && !Number.isFinite(value))
      reject("Automation input must be finite.");
    if (
      typeof value === "string" &&
      (value.length > 4000 ||
        (value.startsWith("$form.") && value !== "$form.value"))
    )
      reject("Only the value field is available in this template.");
  }
  if (
    input.confirmation !== undefined &&
    (typeof input.confirmation !== "string" ||
      !input.confirmation.trim() ||
      input.confirmation.length > 500)
  )
    reject("Invalid automation confirmation.");
  return JSON.parse(canonicalJson(input)) as AutomationBinding;
}
function substitute(value: Json, parameters: JsonObject): Json {
  if (Array.isArray(value)) return value.map((v) => substitute(v, parameters));
  if (object(value)) {
    if (Object.keys(value).length === 1 && typeof value.$param === "string")
      return parameters[value.$param];
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        substitute(v as Json, parameters),
      ]),
    );
  }
  return value;
}
/** Reconstruct from trusted bundled content before trusting persisted provenance. */
function expectedDocument(
  template: TemplateDefinition,
  parameters: JsonObject,
  messageId: bigint,
  revision: number,
): UiDocument {
  keys(parameters, Object.keys(template.parameters.properties!));
  for (const [key, schema] of Object.entries(template.parameters.properties!)) {
    const value = parameters[key];
    if (
      typeof value !== "string" ||
      value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? 4000)
    )
      reject(`Invalid parameter: ${key}`);
  }
  const instanceId = `pear-ui:${messageId}`;
  const mapping = Object.fromEntries(
    template.nodes.map((n) => [n.id as string, `${instanceId}:${n.id}`]),
  );
  const actionBindings = template.actionSlots.length
    ? { submit: "pear.manual-automation" }
    : {};
  const nodes = template.nodes.map((raw) => {
    const node = substitute(raw, parameters) as JsonObject;
    return {
      ...node,
      id: mapping[raw.id as string],
      parentId: raw.parentId === null ? null : mapping[raw.parentId as string],
      ...(node.action
        ? {
            action: {
              ...(node.action as JsonObject),
              slot: "pear.manual-automation",
            },
          }
        : {}),
    };
  });
  return validateDocument(
    {
      protocol: "trellis_ui_v1",
      documentId: `pear-message:${messageId}`,
      revision,
      catalogVersion: CATALOG.version,
      rootId: mapping[template.rootId],
      nodes,
      retiredIds: [],
      template: {
        id: template.id,
        version: template.version,
        hash: template.hash,
        instanceId,
        parameters,
        mapping,
        actionBindings,
        state: "linked",
      },
    },
    CATALOG,
  );
}
export function readSavedUi(json: string, messageId: bigint): SavedUi {
  if (new TextEncoder().encode(json).length > 160000)
    reject("Saved interface exceeds the size limit.");
  const raw: unknown = JSON.parse(json);
  keys(raw, ["v", "document", "bindings", "receipts"]);
  if (raw.v !== SAVED_UI_VERSION)
    reject("Unsupported saved-interface version.");
  const document = validateDocument(raw.document, CATALOG);
  const origin = document.template;
  if (!origin) reject("Saved interfaces require pinned template provenance.");
  const template = templateById(origin.id, origin.version);
  const expected = expectedDocument(
    template,
    origin.parameters,
    messageId,
    document.revision,
  );
  if (canonicalJson(document) !== canonicalJson(expected))
    reject("Saved interface differs from its pinned template.");
  keys(raw.bindings, ["submit"]);
  const bindings = template.actionSlots.length
    ? { submit: validateBinding(raw.bindings.submit) }
    : {};
  if (canonicalJson(raw.bindings) !== canonicalJson(bindings))
    reject("Unexpected action binding.");
  if (!Array.isArray(raw.receipts) || raw.receipts.length > 32)
    reject("Invalid commit receipts.");
  const requests = new Set<string>();
  for (const receipt of raw.receipts) {
    keys(receipt, ["requestId", "intentHash", "payloadHash", "revision"]);
    if (
      typeof receipt.requestId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(receipt.requestId) ||
      requests.has(receipt.requestId) ||
      typeof receipt.intentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.intentHash) ||
      typeof receipt.payloadHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.payloadHash) ||
      !Number.isSafeInteger(receipt.revision) ||
      (receipt.revision as number) < 0 ||
      (receipt.revision as number) > document.revision
    )
      reject("Invalid commit receipt.");
    requests.add(receipt.requestId);
  }
  return {
    v: SAVED_UI_VERSION,
    document,
    bindings,
    receipts: raw.receipts as CommitReceipt[],
  };
}
export async function createSavedUi(
  messageId: bigint,
  templateId: string,
  version: string,
  parameters: JsonObject,
  binding?: unknown,
): Promise<SavedUiPayload> {
  const template = templateById(templateId, version);
  const document = await instantiateTemplate(
    template,
    { ...defaultParameters(template), ...parameters },
    {
      documentId: `pear-message:${messageId}`,
      instanceId: `pear-ui:${messageId}`,
      catalog: CATALOG,
      actionBindings: template.actionSlots.length
        ? { submit: "pear.manual-automation" }
        : {},
    },
  );
  if (!template.actionSlots.length && binding !== undefined)
    reject("This template has no action slots.");
  return {
    v: SAVED_UI_VERSION,
    document,
    bindings: template.actionSlots.length
      ? { submit: validateBinding(binding) }
      : {},
  };
}
export async function updateSavedUi(
  current: SavedUi,
  parameters: JsonObject,
  requestId: string,
): Promise<SavedUiPayload> {
  const origin = current.document.template!;
  let document = await updateTemplateParameters(
    current.document,
    templateById(origin.id, origin.version),
    { ...origin.parameters, ...parameters },
    CATALOG,
    requestId,
  );
  // Even an unchanged parameter request gets a committed revision and receipt.
  if (document.revision === current.document.revision)
    document = validateDocument(
      { ...document, revision: document.revision + 1 },
      CATALOG,
    );
  return { v: SAVED_UI_VERSION, document, bindings: current.bindings };
}
