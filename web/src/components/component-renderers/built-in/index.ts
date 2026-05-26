import {
  registerRenderer,
} from "@eclosion-tech/pulp";
import { ContainerRenderer } from "./Container";
import { HeadingRenderer } from "./Heading";
import { ImageRenderer } from "./Image";
import { ImageBlockRenderer } from "./ImageBlock";
import { InputRenderer } from "./Input";
import { ButtonRenderer } from "./Button";
import { CodeRefRenderer } from "./CodeRef";
import { PageLinkRenderer } from "./PageLink";
import { ConversationRenderer } from "./Conversation";
import { AudioRenderer } from "./Audio";
import { FormRenderer } from "./Form";
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
  registerRenderer("ImageBlock", ImageBlockRenderer);
  registerRenderer("Input", InputRenderer);
  registerRenderer("Button", ButtonRenderer);
  registerRenderer("CodeRef", CodeRefRenderer);
  registerRenderer("PageLink", PageLinkRenderer);
  registerRenderer("Conversation", ConversationRenderer);
  registerRenderer("Audio", AudioRenderer);
  registerRenderer("Form", FormRenderer);

  registerRenderer("Table", DataBoundPlaceholder);
  registerRenderer("Card", DataBoundPlaceholder);
  registerRenderer("List", DataBoundPlaceholder);
}
