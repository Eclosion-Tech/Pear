"use client";

import { readPageComponentReference, PAGE_PANEL_TYPE } from "@pear/trellis-ui";
import { referenceTree, type ReferenceSource } from "@eclosion-tech/pulp";
import { pearReferences } from "./PearReferenceSource";
import { TrellisPagePanelRenderer } from "./TrellisPagePanel";
function Contents({
  source,
  surfaceId,
  blockId,
}: {
  source: ReferenceSource;
  surfaceId: bigint;
  blockId: bigint;
}) {
  const tree = referenceTree(source.tree, { surfaceId, blockId });
  if (tree.loading) return <p role="status">Loading page panel…</p>;
  const node = tree.root;
  const def = node && tree.defs.get(node.componentType);
  if (!node || !def || node.componentType !== PAGE_PANEL_TYPE)
    return (
      <p role="status">
        This page panel is unavailable or you no longer have access to its
        source.
      </p>
    );
  return (
    <TrellisPagePanelRenderer
      node={node}
      tree={tree}
      def={def}
      children={null}
    />
  );
}
export function PageComponentReference({ json }: { json: string }) {
  let reference;
  try {
    reference = readPageComponentReference(json);
  } catch {
    return (
      <p role="alert">
        This saved component reference is invalid. Its stored content has been
        retained.
      </p>
    );
  }
  const target = {
    surfaceId: BigInt(reference.surfaceId),
    blockId: BigInt(reference.blockId),
  };
  const Source = pearReferences.Source;
  return (
    <Source key={`${reference.surfaceId}:${reference.blockId}`} target={target}>
      {(source) => (
        <Contents
          source={source}
          surfaceId={target.surfaceId}
          blockId={target.blockId}
        />
      )}
    </Source>
  );
}
