import {
  registerRenderer,
} from "@eclosion-tech/pulp";
import { ContainerRenderer } from "./Container";
import { HeadingRenderer } from "./Heading";
import { ImageRenderer } from "./Image";
import { InputRenderer } from "./Input";
import { ButtonRenderer } from "./Button";
import { CodeRefRenderer } from "./CodeRef";
import { DataBoundPlaceholder } from "./DataBoundPlaceholder";

/**
 * Pear-specific block renderers — registered alongside pulp's core
 * `RichText` via `registerCoreBlocks()` in `PearComponentTreeRenderer`.
 */
let registered = false;

export function registerPearBuiltinRenderers(): void {
  if (registered) return;
  registered = true;

  registerRenderer("Container", ContainerRenderer);
  registerRenderer("Heading", HeadingRenderer);
  registerRenderer("Image", ImageRenderer);
  registerRenderer("Input", InputRenderer);
  registerRenderer("Button", ButtonRenderer);
  registerRenderer("CodeRef", CodeRefRenderer);

  registerRenderer("Form", DataBoundPlaceholder);
  registerRenderer("Table", DataBoundPlaceholder);
  registerRenderer("Card", DataBoundPlaceholder);
  registerRenderer("List", DataBoundPlaceholder);
}
