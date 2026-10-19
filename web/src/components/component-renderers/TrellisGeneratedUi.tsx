"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ComponentType,
} from "react";
import {
  PulpProvider,
  RichTextRenderer,
  HeadingRenderer,
  type BlockRendererProps as PulpRendererProps,
  type PulpMutations,
} from "@eclosion-tech/pulp";
import {
  defaultRenderers,
  TrellisSurface,
  useTrellisField,
  useTrellisNode,
  type BlockRendererProps,
  type RendererCatalog,
} from "@eclosion-tech/trellis-react";
import type {
  PreparedPearUi,
  PearLegacyAction,
} from "@/src/lib/trellisGeneratedUi";
import { useGeneratedUiInteraction } from "./GeneratedUiInteractionContext";
import { ButtonRenderer } from "./built-in/Button";
import { ContainerRenderer } from "./built-in/Container";
import {
  BulletListItemRenderer,
  NumberedListItemRenderer,
  ChecklistItemRenderer,
} from "./built-in/DocumentListItem";
import { MarkdownTableRenderer } from "./built-in/MarkdownTable";

const Actions = createContext<ReadonlyMap<string, PearLegacyAction>>(new Map());
const CONFIG = { idbPrefix: "", readOnly: true };
const NOOP: PulpMutations = {
  insertBlock() {},
  deleteBlock() {},
  moveBlock() {},
  updateBlockProps() {},
  saveYjsState() {},
};
function legacyProps(props: BlockRendererProps): PulpRendererProps {
  return { ...props, def: props.tree.defs.get(props.node.componentType)! };
}
function reusePulp(Renderer: ComponentType<PulpRendererProps>) {
  return function ScopedPulpRenderer(props: BlockRendererProps) {
    return (
      <PulpProvider tree={props.tree} config={CONFIG} mutations={NOOP}>
        <Renderer {...legacyProps(props)} />
      </PulpProvider>
    );
  };
}
function Input({ node }: BlockRendererProps) {
  const props = JSON.parse(node.props) as {
    name?: string;
    label?: string;
    placeholder?: string;
    required?: boolean;
  };
  const field = useTrellisField(node.id);
  const generatedUi = useGeneratedUiInteraction();
  const current = useRef(field.value);
  current.current = field.value;
  useEffect(() => {
    if (!props.name?.trim() || !generatedUi) return;
    return generatedUi.registerField(
      props.name.trim(),
      () => current.current,
      props.required ?? false,
    );
  }, [generatedUi, props.name, props.required]);
  return (
    <label className="my-2 flex flex-col gap-1">
      {props.label ? (
        <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {props.label}
          {props.required ? <span className="ml-1 text-red-500">*</span> : null}
        </span>
      ) : null}
      <input
        type="text"
        value={field.value}
        readOnly={!props.name?.trim()}
        onChange={(event) => field.setValue(event.target.value)}
        placeholder={props.placeholder ?? ""}
        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      />
    </label>
  );
}
function Button(props: BlockRendererProps) {
  const source = useTrellisNode(props.node.id);
  const action = useContext(Actions).get(source.id);
  // Preserve the original wire node ID, original $form mapping, confirmation,
  // and existing reducer/queue implementation. Never treat dispatch as completion.
  const node = {
    ...props.node,
    id: /^[0-9]+$/.test(source.id) ? BigInt(source.id) : props.node.id,
    props: JSON.stringify({
      ...source.props,
      ...(action ? { action: { type: "trigger_automation", ...action } } : {}),
    }),
  };
  return <ButtonRenderer {...legacyProps(props)} node={node} />;
}
const RENDERERS: RendererCatalog = {
  ...defaultRenderers,
  Container: reusePulp(ContainerRenderer),
  RichText: reusePulp(RichTextRenderer),
  Heading: reusePulp(HeadingRenderer),
  BulletListItem: reusePulp(BulletListItemRenderer),
  NumberedListItem: reusePulp(NumberedListItemRenderer),
  ChecklistItem: reusePulp(ChecklistItemRenderer),
  MarkdownTable: reusePulp(MarkdownTableRenderer),
  Input,
  Button,
};

export function TrellisGeneratedUi({
  prepared,
  principalKey,
}: {
  prepared: PreparedPearUi;
  principalKey: string;
}) {
  return (
    <Actions.Provider value={prepared.actionsByNode}>
      <div
        className="pear-static-component-tree my-2"
        data-pear-ui-runtime="trellis"
      >
        <TrellisSurface
          document={prepared.document}
          catalog={prepared.catalog}
          renderers={RENDERERS}
          principalKey={principalKey}
        />
      </div>
    </Actions.Provider>
  );
}
