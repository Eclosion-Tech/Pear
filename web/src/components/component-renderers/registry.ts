import type { FC, ReactNode } from "react";
import type {
  ComponentNode,
  ComponentTypeDefinition,
} from "@/src/module_bindings/types";
import type { ComponentTree } from "@/src/hooks/useComponentTree";

/**
 * Props every component renderer accepts.
 *
 * The walker (`<ComponentNodeView>`) is responsible for resolving children
 * and passing them in. Renderers consume `children` directly if they accept
 * children, or ignore it for leaf types — `def.acceptsChildren` is the
 * declarative truth, and the substrate's reducers enforce that
 * `acceptsChildren = false` types never receive children in the first place
 * (`docs/PEAR_COMPONENT_NODE_SCHEMA.md` § Integrity model).
 */
export type ComponentRendererProps = {
  node: ComponentNode;
  def: ComponentTypeDefinition;
  tree: ComponentTree;
  children: ReactNode;
};

export type ComponentRenderer = FC<ComponentRendererProps>;

/**
 * The code-side component registry. See `docs/PEAR_WEB_RENDERER.md` §
 * Registry: code side vs. table side for the coupling rules.
 *
 * The table (`component_type_definition`) is the **declaration**:
 * `prop_schema`, `capabilities`, `has_yjs_state`, `accepts_children`. The
 * map below is the **implementation**: React components. Drift between the
 * two surfaces shows up at registry-init time (`assertRegistryAgainstDefs`)
 * with a console warning per missing pair.
 *
 * v1 ships read-only renderers for every built-in. Sprints 2–4 add
 * interactivity; sprint 4 ports the Pear-specific BlockNote-era custom
 * blocks (`PageLink`, `Conversation`, `Audio`, richer `Image`).
 */
const registry = new Map<string, ComponentRenderer>();

export function registerRenderer(
  componentType: string,
  renderer: ComponentRenderer,
): void {
  registry.set(componentType, renderer);
}

export function getRenderer(
  componentType: string,
): ComponentRenderer | undefined {
  return registry.get(componentType);
}

export function getRegisteredTypes(): string[] {
  return Array.from(registry.keys());
}

/**
 * Compare the code-side registry against the table-side `defs`. Logs once
 * per session per missing pair. Two directions:
 *   1. `componentType` in `defs` but no code-side renderer → workspace can
 *      encounter this type and will fall back to <UnregisteredComponentFallback>.
 *   2. `componentType` registered in code but no row in `defs` → harmless
 *      for rendering, but indicates seeding drift (a new built-in shipped
 *      without a migration step, or a workspace running an old module).
 *
 * Renderer-side warnings are non-blocking; the substrate's defensive
 * fallback always works.
 */
export function assertRegistryAgainstDefs(
  defs: Map<string, ComponentTypeDefinition>,
): void {
  if (typeof console === "undefined") return;
  const reported = warnedTypes;
  for (const t of defs.keys()) {
    if (!registry.has(t) && !reported.has(`missing-renderer:${t}`)) {
      reported.add(`missing-renderer:${t}`);
      console.warn(
        `[component-registry] no code-side renderer for "${t}" — workspace will fall back to <UnregisteredComponentFallback>.`,
      );
    }
  }
  for (const t of registry.keys()) {
    if (!defs.has(t) && !reported.has(`missing-def:${t}`)) {
      reported.add(`missing-def:${t}`);
      console.warn(
        `[component-registry] code-side renderer for "${t}" has no ComponentTypeDefinition row — workspace is missing this seed.`,
      );
    }
  }
}

const warnedTypes = new Set<string>();
