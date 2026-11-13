"use client";
import { useParams, useRouter } from "next/navigation";
import { usePulpOptional, type BlockRendererProps } from "@eclosion-tech/pulp";
import { readPropertyReference, type PropertyReference } from "@pear/trellis-ui";
import { useWorkspaceComponentData } from "@/src/hooks/useWorkspaceComponentData";
import { useUpdateComponentProps } from "@/src/hooks/usePages";
import { propertySourceChoices, resolvePropertyReference } from "@/src/lib/property-reference";
import { PropertyReferenceView } from "./PropertyReferenceView";
export { PropertyReferenceView } from "./PropertyReferenceView";
import { blockReferenceHref } from "@/src/lib/blockReferenceLink";

export function PropertyReferenceRenderer({ node }: BlockRendererProps) {
  const { access, data } = useWorkspaceComponentData(node.surfaceId);
  const update = useUpdateComponentProps();
  const pulp = usePulpOptional();
  const router = useRouter();
  const route = useParams();
  const slug = Array.isArray(route?.slug) ? route.slug[0] : route?.slug;
  let reference: PropertyReference | null = null;
  try { reference = readPropertyReference(node.props); } catch { /* Retain unknown formats. */ }
  const result = access.permission ? resolvePropertyReference(node.props, String(node.surfaceId), data) : { status: "unavailable" as const };
  return <PropertyReferenceView key={`${node.id}:${node.surfaceId}:${access.principal}:${access.canEdit}:${result.status}`}
    result={result} reference={reference} canConfigure={!!pulp && access.canEdit && !pulp.config.readOnly}
    choices={propertySourceChoices(data)} containingPageId={String(node.surfaceId)}
    onSave={ref => update({ componentId: node.id, propsJson: JSON.stringify(ref) })}
    onOpen={edit => {
      if (result.status !== "ready") return;
      const href = blockReferenceHref({ surfaceId: BigInt(result.pageId) }, slug);
      router.push(edit && result.canEdit && reference ? `${href}?editProperty=${reference.binding.field}#property-${reference.binding.field}` : href);
    }} />;
}
