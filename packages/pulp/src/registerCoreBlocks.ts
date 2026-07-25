import { registerRenderer } from "./registry";
import { RichTextRenderer } from "./rich-text/RichText";
import { HeadingRenderer } from "./heading/HeadingRenderer";
import { RepeaterRenderer } from "./repeater/RepeaterRenderer";

let registered = false;

/** Registers pulp's core block types. Call once at app bootstrap. */
export function registerCoreBlocks(): void {
  if (registered) return;
  registered = true;
  registerRenderer("RichText", RichTextRenderer);
  registerRenderer("Heading", HeadingRenderer);
  // Repeater is pulp-native (ADR D1) rather than host-supplied: materialization
  // and render memoization are one decision, so they live together here.
  registerRenderer("Repeater", RepeaterRenderer);
}
