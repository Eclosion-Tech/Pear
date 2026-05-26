import { registerRenderer } from "./registry";
import { RichTextRenderer } from "./rich-text/RichText";

let registered = false;

/** Registers pulp's core block types. Call once at app bootstrap. */
export function registerCoreBlocks(): void {
  if (registered) return;
  registered = true;
  registerRenderer("RichText", RichTextRenderer);
}
